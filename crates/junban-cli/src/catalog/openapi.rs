//! OpenAPI loading and self-contained JSON Schema resolution for catalog tools.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use super::WrapperKind;

/// Checked OpenAPI artifact embedded at compile time.
pub const OPENAPI_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../openapi/junban-v1.json"
));

#[derive(Debug, Clone)]
pub struct OpenApiOperation {
    pub operation_id: String,
    pub method: String,
    pub path: String,
    pub summary: Option<String>,
    pub parameters: Vec<Parameter>,
    pub body_schema: Option<Value>,
    pub body_is_octet_stream: bool,
    pub success_schema: Option<Value>,
    pub requires_idempotency: bool,
}

#[derive(Debug, Clone)]
pub struct Parameter {
    pub name: String,
    pub location: ParamLocation,
    pub required: bool,
    pub schema: Value,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamLocation {
    Path,
    Query,
    Header,
}

pub fn parse_openapi() -> Result<Value, String> {
    serde_json::from_str(OPENAPI_JSON)
        .map_err(|error| format!("OpenAPI JSON parse failed: {error}"))
}

pub fn iter_operations(doc: &Value) -> Result<Vec<OpenApiOperation>, String> {
    let paths = doc
        .get("paths")
        .and_then(Value::as_object)
        .ok_or_else(|| "OpenAPI document missing paths".to_owned())?;
    let mut operations = Vec::new();
    for (path, item) in paths {
        let item = item
            .as_object()
            .ok_or_else(|| format!("OpenAPI path item for '{path}' is not an object"))?;
        for method in ["get", "post", "put", "patch", "delete"] {
            let Some(op) = item.get(method) else {
                continue;
            };
            let op_obj = op
                .as_object()
                .ok_or_else(|| format!("OpenAPI operation {method} {path} is not an object"))?;
            let operation_id = op_obj
                .get("operationId")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("OpenAPI operation {method} {path} missing operationId"))?
                .to_owned();
            let summary = op_obj
                .get("summary")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mut parameters = Vec::new();
            let mut requires_idempotency = false;
            if let Some(params) = op_obj.get("parameters").and_then(Value::as_array) {
                for param in params {
                    let param_obj = param
                        .as_object()
                        .ok_or_else(|| format!("{operation_id}: parameter is not an object"))?;
                    let name = param_obj
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{operation_id}: parameter missing name"))?
                        .to_owned();
                    let location_raw = param_obj
                        .get("in")
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{operation_id}: parameter '{name}' missing in"))?;
                    if name == "Idempotency-Key" {
                        requires_idempotency = true;
                        continue;
                    }
                    let mut location = match location_raw {
                        "path" => ParamLocation::Path,
                        "query" => ParamLocation::Query,
                        "header" => ParamLocation::Header,
                        other => {
                            return Err(format!(
                                "{operation_id}: unsupported parameter location '{other}'"
                            ));
                        }
                    };
                    // utoipa occasionally marks query structs as path; correct using the template.
                    if location == ParamLocation::Path && !path_template_has_param(path, &name) {
                        location = ParamLocation::Query;
                    }
                    if location == ParamLocation::Header {
                        continue;
                    }
                    let required = param_obj
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(location == ParamLocation::Path);
                    let schema = param_obj
                        .get("schema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "string" }));
                    let description = param_obj
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    parameters.push(Parameter {
                        name,
                        location,
                        required,
                        schema,
                        description,
                    });
                }
            }

            let mut body_schema = None;
            let mut body_is_octet_stream = false;
            if let Some(request_body) = op_obj.get("requestBody") {
                let content = request_body
                    .get("content")
                    .and_then(Value::as_object)
                    .ok_or_else(|| format!("{operation_id}: requestBody missing content"))?;
                if content.contains_key("application/octet-stream") {
                    body_is_octet_stream = true;
                } else if let Some(json_body) = content.get("application/json") {
                    body_schema = json_body.get("schema").cloned();
                } else {
                    return Err(format!(
                        "{operation_id}: unsupported requestBody content types"
                    ));
                }
            }

            let success_schema = success_response_schema(op_obj);

            operations.push(OpenApiOperation {
                operation_id,
                method: method.to_ascii_uppercase(),
                path: path.clone(),
                summary,
                parameters,
                body_schema,
                body_is_octet_stream,
                success_schema,
                requires_idempotency,
            });
        }
    }
    operations.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
    Ok(operations)
}

fn path_template_has_param(path: &str, name: &str) -> bool {
    path.split('/')
        .any(|segment| segment == format!("{{{name}}}") || segment == format!("{{ {name} }}"))
}

fn success_response_schema(op_obj: &Map<String, Value>) -> Option<Value> {
    let responses = op_obj.get("responses")?.as_object()?;
    for code in ["200", "201", "204"] {
        let Some(response) = responses.get(code) else {
            continue;
        };
        if code == "204" {
            return None;
        }
        // Media types are object keys, not JSON Pointer path segments (`/` in
        // `application/json` would otherwise be interpreted as a separator).
        return response
            .get("content")
            .and_then(Value::as_object)
            .and_then(|content| content.get("application/json"))
            .and_then(|media| media.get("schema"))
            .cloned();
    }
    None
}

pub fn path_param_names(operation: &OpenApiOperation) -> Vec<String> {
    let names: Vec<String> = operation
        .parameters
        .iter()
        .filter(|param| param.location == ParamLocation::Path)
        .map(|param| param.name.clone())
        .collect();
    // Prefer template order.
    let mut ordered = Vec::new();
    for segment in operation.path.split('/') {
        if let Some(name) = segment
            .strip_prefix('{')
            .and_then(|value| value.strip_suffix('}'))
            && names.iter().any(|existing| existing == name)
        {
            ordered.push(name.to_owned());
        }
    }
    for name in names {
        if !ordered.contains(&name) {
            ordered.push(name);
        }
    }
    ordered
}

pub fn query_param_names(operation: &OpenApiOperation) -> Vec<String> {
    operation
        .parameters
        .iter()
        .filter(|param| param.location == ParamLocation::Query)
        .map(|param| param.name.clone())
        .collect()
}

/// Build a self-contained object schema merging path, query, and body inputs.
pub fn build_input_schema(
    doc: &Value,
    operation: &OpenApiOperation,
    wrapper: Option<WrapperKind>,
) -> Result<Value, String> {
    let _ = wrapper;
    let mut properties = Map::new();
    let mut required = Vec::new();
    let mut seen = BTreeSet::new();

    for param in &operation.parameters {
        if param.location == ParamLocation::Header {
            continue;
        }
        if !seen.insert(param.name.clone()) {
            return Err(format!(
                "{}: duplicate parameter name '{}'",
                operation.operation_id, param.name
            ));
        }
        let mut schema = resolve_schema(doc, &param.schema, &mut Vec::new())?;
        if let Some(description) = &param.description
            && let Some(object) = schema.as_object_mut()
        {
            object
                .entry("description".to_owned())
                .or_insert_with(|| Value::String(description.clone()));
        }
        properties.insert(param.name.clone(), schema);
        if param.required {
            required.push(param.name.clone());
        }
    }

    if operation.body_is_octet_stream {
        // File path is supplied by the restore wrapper; no raw body field in the tool schema.
    } else if let Some(body_schema) = &operation.body_schema {
        let resolved = resolve_schema(doc, body_schema, &mut Vec::new())?;
        merge_body_schema(
            &operation.operation_id,
            &resolved,
            &mut properties,
            &mut required,
            &mut seen,
        )?;
    }

    required.sort();
    Ok(json!({
        "type": "object",
        "properties": Value::Object(properties),
        "required": required,
        "additionalProperties": false
    }))
}

fn merge_body_schema(
    operation_id: &str,
    body_schema: &Value,
    properties: &mut Map<String, Value>,
    required: &mut Vec<String>,
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    let obj = body_schema
        .as_object()
        .ok_or_else(|| format!("{operation_id}: request body schema must resolve to an object"))?;
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("object");
    if kind != "object" {
        return Err(format!(
            "{operation_id}: request body schema type must be object, got {kind}"
        ));
    }
    let body_properties = obj
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{operation_id}: request body object missing properties"))?;
    for (name, schema) in body_properties {
        if !seen.insert(name.clone()) {
            return Err(format!(
                "{operation_id}: body field '{name}' conflicts with a path/query parameter"
            ));
        }
        properties.insert(name.clone(), schema.clone());
    }
    if let Some(body_required) = obj.get("required").and_then(Value::as_array) {
        for name in body_required {
            let name = name
                .as_str()
                .ok_or_else(|| format!("{operation_id}: body required entry is not a string"))?;
            if !required.iter().any(|existing| existing == name) {
                required.push(name.to_owned());
            }
        }
    }
    Ok(())
}

pub fn build_output_schema(
    doc: &Value,
    operation: &OpenApiOperation,
    response_mode: super::ResponseMode,
    wrapper: Option<WrapperKind>,
) -> Result<Value, String> {
    use super::ResponseMode;

    if matches!(response_mode, ResponseMode::Download) {
        return Ok(json!({
            "type": "object",
            "properties": {
                "bytes_written": { "type": "integer", "format": "uint64", "minimum": 0 },
                "output_path": { "type": "string" }
            },
            "required": ["bytes_written", "output_path"],
            "additionalProperties": false
        }));
    }
    if matches!(response_mode, ResponseMode::Empty) {
        return Ok(json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }));
    }

    let schema = operation.success_schema.as_ref().ok_or_else(|| {
        format!(
            "{}: JSON success response is missing a schema",
            operation.operation_id
        )
    })?;
    let mut resolved = resolve_schema(doc, schema, &mut Vec::new())?;
    if matches!(wrapper, Some(WrapperKind::RotateToken)) {
        let object = resolved.as_object_mut().ok_or_else(|| {
            format!(
                "{}: rotation output must be an object",
                operation.operation_id
            )
        })?;
        let properties = object
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                format!(
                    "{}: rotation output object is missing properties",
                    operation.operation_id
                )
            })?;
        if properties.remove("token").is_none() {
            return Err(format!(
                "{}: rotation wire response is missing token",
                operation.operation_id
            ));
        }
        properties.insert("token_path".to_owned(), json!({ "type": "string" }));
        if let Some(required) = object.get_mut("required").and_then(Value::as_array_mut) {
            required.retain(|field| field.as_str() != Some("token"));
            if !required
                .iter()
                .any(|field| field.as_str() == Some("token_path"))
            {
                required.push(Value::String("token_path".to_owned()));
            }
            required.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
        } else {
            object.insert("required".to_owned(), json!(["token_path"]));
        }
        object.insert("additionalProperties".to_owned(), Value::Bool(false));
    }
    Ok(resolved)
}

/// Resolve `$ref` and compose allOf into a self-contained schema value.
pub fn resolve_schema(
    doc: &Value,
    schema: &Value,
    stack: &mut Vec<String>,
) -> Result<Value, String> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let name = reference
            .strip_prefix("#/components/schemas/")
            .ok_or_else(|| format!("unsupported schema $ref '{reference}'"))?;
        if stack.contains(&name.to_owned()) {
            // Break cycles with a permissive object placeholder.
            return Ok(json!({
                "type": "object",
                "description": format!("circular ref to {name}")
            }));
        }
        let target = doc
            .pointer(&format!("/components/schemas/{name}"))
            .ok_or_else(|| format!("unresolved schema $ref '{reference}'"))?
            .clone();
        stack.push(name.to_owned());
        let resolved = resolve_schema(doc, &target, stack)?;
        stack.pop();
        return Ok(resolved);
    }

    match schema {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                match key.as_str() {
                    "properties" => {
                        let props = value
                            .as_object()
                            .ok_or_else(|| "schema properties must be an object".to_owned())?;
                        let mut resolved_props = Map::new();
                        // BTreeMap iteration via collected keys for determinism.
                        let mut keys: Vec<&String> = props.keys().collect();
                        keys.sort();
                        for prop_key in keys {
                            resolved_props.insert(
                                prop_key.clone(),
                                resolve_schema(doc, &props[prop_key], stack)?,
                            );
                        }
                        out.insert(key.clone(), Value::Object(resolved_props));
                    }
                    "items" => {
                        out.insert(key.clone(), resolve_schema(doc, value, stack)?);
                    }
                    "additionalProperties" => {
                        if value.is_boolean() {
                            out.insert(key.clone(), value.clone());
                        } else {
                            out.insert(key.clone(), resolve_schema(doc, value, stack)?);
                        }
                    }
                    "oneOf" | "anyOf" | "allOf" => {
                        let arr = value
                            .as_array()
                            .ok_or_else(|| format!("schema {key} must be an array"))?;
                        if key == "allOf" {
                            let mut merged = json!({"type": "object", "properties": {}});
                            for item in arr {
                                let resolved = resolve_schema(doc, item, stack)?;
                                merge_all_of(&mut merged, &resolved)?;
                            }
                            // Return merged object directly when allOf was the only combiner.
                            if map.len() == 1 {
                                return Ok(merged);
                            }
                            out.insert(key.clone(), json!([merged]));
                        } else {
                            let mut resolved_items = Vec::with_capacity(arr.len());
                            for item in arr {
                                resolved_items.push(resolve_schema(doc, item, stack)?);
                            }
                            out.insert(key.clone(), Value::Array(resolved_items));
                        }
                    }
                    _ => {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

fn merge_all_of(target: &mut Value, source: &Value) -> Result<(), String> {
    let target_obj = target
        .as_object_mut()
        .ok_or_else(|| "allOf merge target must be object".to_owned())?;
    let source_obj = source
        .as_object()
        .ok_or_else(|| "allOf member must resolve to object".to_owned())?;
    if let Some(props) = source_obj.get("properties").and_then(Value::as_object) {
        let target_props = target_obj
            .entry("properties".to_owned())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "allOf properties must be object".to_owned())?;
        for (key, value) in props {
            target_props.insert(key.clone(), value.clone());
        }
    }
    if let Some(required) = source_obj.get("required").and_then(Value::as_array) {
        let target_required = target_obj
            .entry("required".to_owned())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| "allOf required must be array".to_owned())?;
        for item in required {
            if !target_required.contains(item) {
                target_required.push(item.clone());
            }
        }
    }
    for (key, value) in source_obj {
        if key == "properties" || key == "required" || key == "type" {
            continue;
        }
        target_obj
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
    Ok(())
}

/// Lookup helper used by executor tests.
#[allow(dead_code)]
pub fn components_schema_names(doc: &Value) -> BTreeSet<String> {
    doc.pointer("/components/schemas")
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// Deterministic property map helper for tests.
#[allow(dead_code)]
pub fn object_property_names(schema: &Value) -> Vec<String> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|map| {
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            keys
        })
        .unwrap_or_default()
}
