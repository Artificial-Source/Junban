use std::{
    env, fmt,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
};

use sha2::{Digest, Sha256};
use wit_parser::{Function, InterfaceId, Resolve, Type, TypeDefKind};

const EXPECTED_WIT_SHA256: &str =
    "5705801973219a0e6981693653f2caefdf1090345b65494750c8d8a9bf4b15f4";
const GENERATED_PATH: &str = "src/private_body_types.rs";
const HOST_ADAPTERS_PATH: &str = "../junban-plugin-host/src/generated_body_adapters.rs";
const WIT_PATH: &str = "wit/plugin.wit";

type Result<T> = std::result::Result<T, CodegenError>;

#[derive(Debug)]
struct CodegenError(String);

impl fmt::Display for CodegenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CodegenError {}

impl From<std::io::Error> for CodegenError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("private body codegen failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let check = match env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => false,
        [argument] if argument == "--check" => true,
        _ => {
            return Err(CodegenError(
                "usage: junban-plugin-body-codegen [--check]".into(),
            ));
        }
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let wit_path = root.join(WIT_PATH);
    let generated_path = root.join(GENERATED_PATH);
    let host_adapters_path = root.join(HOST_ADAPTERS_PATH);
    let wit = fs::read_to_string(&wit_path)?;
    let wit_sha256 = hex(Sha256::digest(wit.as_bytes()).as_slice());
    if wit_sha256 != EXPECTED_WIT_SHA256 {
        return Err(CodegenError(format!(
            "WIT SHA-256 drifted: expected {EXPECTED_WIT_SHA256}, got {wit_sha256}"
        )));
    }

    let generated = generate_private_types(&wit, &wit_sha256)?;
    let host_adapters = generate_host_adapters(&wit, &wit_sha256)?;
    let artifacts = [
        (generated_path, generated),
        (host_adapters_path, host_adapters),
    ];
    if check {
        for (path, expected) in &artifacts {
            let current = fs::read(path)?;
            if current != expected.as_bytes() {
                return Err(CodegenError(format!(
                    "{} is stale; regenerate it with this binary",
                    relative(&root, path)
                )));
            }
        }
        println!("generated private body artifacts and WIT SHA-256 are exact");
    } else {
        for (path, generated) in artifacts {
            fs::write(&path, generated)?;
            println!("generated {}", relative(&root, &path));
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

struct Generator<'a> {
    resolve: &'a Resolve,
    output: String,
}

fn generate_private_types(wit: &str, wit_sha256: &str) -> Result<String> {
    let mut resolve = Resolve::default();
    let package_id = resolve
        .push_str("plugin.wit", wit)
        .map_err(|_| CodegenError("canonical WIT did not parse".into()))?;
    let package = &resolve.packages[package_id];
    if package.name.namespace != "junban"
        || package.name.name != "plugin"
        || package
            .name
            .version
            .as_ref()
            .map(ToString::to_string)
            .as_deref()
            != Some("0.1.0")
    {
        return Err(CodegenError("unexpected WIT package identity".into()));
    }
    let types_id = package
        .interfaces
        .get("types")
        .copied()
        .ok_or_else(|| CodegenError("WIT types interface is missing".into()))?;

    let mut generator = Generator {
        resolve: &resolve,
        output: String::with_capacity(64 * 1024),
    };
    generator.header(wit_sha256);
    generator.named_types(types_id)?;
    generator.result_type();
    for (interface_name, interface_id) in &package.interfaces {
        if interface_name != "types" {
            generator.function_adapters(interface_name, *interface_id)?;
        }
    }
    while generator.output.ends_with("\n\n") {
        generator.output.pop();
    }
    Ok(generator.output)
}

fn generate_host_adapters(wit: &str, wit_sha256: &str) -> Result<String> {
    let mut resolve = Resolve::default();
    let package_id = resolve
        .push_str("plugin.wit", wit)
        .map_err(|_| CodegenError("canonical WIT did not parse".into()))?;
    let package = &resolve.packages[package_id];
    let types_id = package
        .interfaces
        .get("types")
        .copied()
        .ok_or_else(|| CodegenError("WIT types interface is missing".into()))?;
    let mut generator = Generator {
        resolve: &resolve,
        output: String::with_capacity(64 * 1024),
    };
    generator.adapter_header(wit_sha256);
    generator.named_type_adapters(types_id)?;
    generator.line(format_args!("}}"));
    while generator.output.ends_with("\n\n") {
        generator.output.pop();
    }
    Ok(generator.output)
}

impl Generator<'_> {
    fn line(&mut self, arguments: fmt::Arguments<'_>) {
        self.output
            .write_fmt(arguments)
            .expect("writing to a String cannot fail");
        self.output.push('\n');
    }

    fn header(&mut self, wit_sha256: &str) {
        self.line(format_args!(
            "// @generated by `cargo run -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen`; do not edit."
        ));
        self.line(format_args!("#![allow(clippy::all)]"));
        self.line(format_args!(""));
        self.line(format_args!(
            "use base64::{{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD}};"
        ));
        self.line(format_args!(
            "use serde::{{Deserialize, Deserializer, Serialize, Serializer, de::Visitor}};"
        ));
        self.line(format_args!(""));
        self.line(format_args!("pub const GENERATED_WIT_SHA256: &str ="));
        self.line(format_args!("    \"{wit_sha256}\";"));
        self.line(format_args!(
            "pub const BYTE_LIST_BYTES_MAX: usize = 4 * 1024 * 1024;"
        ));
        self.line(format_args!(""));
        self.line(format_args!(
            "#[derive(Clone, Debug, Default, Eq, PartialEq)]"
        ));
        self.line(format_args!("pub struct ByteList(Vec<u8>);"));
        self.line(format_args!(""));
        self.line(format_args!("impl ByteList {{"));
        self.line(format_args!(
            "    pub fn new(bytes: Vec<u8>) -> Result<Self, crate::SdkError> {{"
        ));
        self.line(format_args!(
            "        if bytes.len() > BYTE_LIST_BYTES_MAX {{"
        ));
        self.line(format_args!(
            "            return Err(crate::SdkError::Protocol {{"
        ));
        self.line(format_args!("                field: \"byte list length\","));
        self.line(format_args!("            }});"));
        self.line(format_args!("        }}"));
        self.line(format_args!("        Ok(Self(bytes))"));
        self.line(format_args!("    }}"));
        self.line(format_args!(""));
        self.line(format_args!("    #[must_use]"));
        self.line(format_args!("    pub fn as_slice(&self) -> &[u8] {{"));
        self.line(format_args!("        &self.0"));
        self.line(format_args!("    }}"));
        self.line(format_args!(""));
        self.line(format_args!("    #[must_use]"));
        self.line(format_args!("    pub fn into_vec(self) -> Vec<u8> {{"));
        self.line(format_args!("        self.0"));
        self.line(format_args!("    }}"));
        self.line(format_args!("}}"));
        self.line(format_args!(""));
        self.line(format_args!("impl Serialize for ByteList {{"));
        self.line(format_args!(
            "    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>"
        ));
        self.line(format_args!("    where"));
        self.line(format_args!("        S: Serializer,"));
        self.line(format_args!("    {{"));
        self.line(format_args!(
            "        if self.0.len() > BYTE_LIST_BYTES_MAX {{"
        ));
        self.line(format_args!(
            "            return Err(serde::ser::Error::custom("
        ));
        self.line(format_args!(
            "                \"byte list exceeds private body bound\","
        ));
        self.line(format_args!("            ));"));
        self.line(format_args!("        }}"));
        self.line(format_args!(
            "        serializer.serialize_str(&URL_SAFE_NO_PAD.encode(&self.0))"
        ));
        self.line(format_args!("    }}"));
        self.line(format_args!("}}"));
        self.line(format_args!(""));
        self.line(format_args!("impl<'de> Deserialize<'de> for ByteList {{"));
        self.line(format_args!(
            "    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>"
        ));
        self.line(format_args!("    where"));
        self.line(format_args!("        D: Deserializer<'de>,"));
        self.line(format_args!("    {{"));
        self.line(format_args!("        struct ByteListVisitor;"));
        self.line(format_args!(""));
        self.line(format_args!(
            "        impl Visitor<'_> for ByteListVisitor {{"
        ));
        self.line(format_args!("            type Value = ByteList;"));
        self.line(format_args!(""));
        self.line(format_args!("            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{"));
        self.line(format_args!(
            "                formatter.write_str(\"strict unpadded base64url bytes\")"
        ));
        self.line(format_args!("            }}"));
        self.line(format_args!(""));
        self.line(format_args!(
            "            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>"
        ));
        self.line(format_args!("            where"));
        self.line(format_args!("                E: serde::de::Error,"));
        self.line(format_args!("            {{"));
        self.line(format_args!(
            "                let encoded_max = BYTE_LIST_BYTES_MAX.saturating_mul(4).div_ceil(3);"
        ));
        self.line(format_args!(
            "                if value.len() > encoded_max {{"
        ));
        self.line(format_args!(
            "                    return Err(E::custom(\"byte list exceeds private body bound\"));"
        ));
        self.line(format_args!("                }}"));
        self.line(format_args!("                let bytes = URL_SAFE_NO_PAD"));
        self.line(format_args!("                    .decode(value)"));
        self.line(format_args!(
            "                    .map_err(|_| E::custom(\"invalid base64url byte list\"))?;"
        ));
        self.line(format_args!("                if bytes.len() > BYTE_LIST_BYTES_MAX || URL_SAFE_NO_PAD.encode(&bytes) != value {{"));
        self.line(format_args!(
            "                    return Err(E::custom(\"noncanonical base64url byte list\"));"
        ));
        self.line(format_args!("                }}"));
        self.line(format_args!("                Ok(ByteList(bytes))"));
        self.line(format_args!("            }}"));
        self.line(format_args!("        }}"));
        self.line(format_args!(""));
        self.line(format_args!(
            "        deserializer.deserialize_str(ByteListVisitor)"
        ));
        self.line(format_args!("    }}"));
        self.line(format_args!("}}"));
        self.line(format_args!(""));
        self.line(format_args!("pub(crate) fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>"));
        self.line(format_args!("where"));
        self.line(format_args!("    D: Deserializer<'de>,"));
        self.line(format_args!("    T: Deserialize<'de>,"));
        self.line(format_args!("{{"));
        self.line(format_args!("    Option::<T>::deserialize(deserializer)"));
        self.line(format_args!("}}"));
        self.line(format_args!(""));
    }

    fn adapter_header(&mut self, wit_sha256: &str) {
        self.line(format_args!(
            "// @generated by `cargo run -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen`; do not edit."
        ));
        self.line(format_args!("#![allow(clippy::all, dead_code)]"));
        self.line(format_args!(""));
        self.line(format_args!("#[rustfmt::skip]"));
        self.line(format_args!("mod generated {{"));
        self.line(format_args!(
            "use crate::bindings::junban::plugin::types as binding;"
        ));
        self.line(format_args!(
            "use junban_plugin_sdk::{{SdkError, private_body_types as neutral}};"
        ));
        self.line(format_args!(""));
        self.line(format_args!(
            "const GENERATED_WIT_SHA256: &str = \"{wit_sha256}\";"
        ));
        self.line(format_args!(
            "type AdapterResult<T> = std::result::Result<T, SdkError>;"
        ));
        self.line(format_args!(""));
    }

    fn named_type_adapters(&mut self, interface_id: InterfaceId) -> Result<()> {
        let interface = &self.resolve.interfaces[interface_id];
        for (wit_name, type_id) in &interface.types {
            let definition = &self.resolve.types[*type_id];
            if definition.name.as_deref() != Some(wit_name) {
                return Err(CodegenError(format!(
                    "type identity drift for `{wit_name}`"
                )));
            }
            let rust_name = rust_type_name(wit_name)?;
            match &definition.kind {
                TypeDefKind::Record(record) => {
                    self.line(format_args!(
                        "impl From<neutral::{rust_name}> for binding::{rust_name} {{"
                    ));
                    self.line(format_args!(
                        "    fn from(value: neutral::{rust_name}) -> Self {{"
                    ));
                    self.line(format_args!("        Self {{"));
                    for field in &record.fields {
                        let name = rust_field_name(&field.name);
                        let converted =
                            self.forward_conversion(field.ty, &format!("value.{name}"))?;
                        self.line(format_args!("            {name}: {converted},"));
                    }
                    self.line(format_args!("        }}"));
                    self.line(format_args!("    }}"));
                    self.line(format_args!("}}"));
                    self.line(format_args!(""));
                    self.line(format_args!(
                        "impl TryFrom<binding::{rust_name}> for neutral::{rust_name} {{"
                    ));
                    self.line(format_args!("    type Error = SdkError;"));
                    self.line(format_args!(
                        "    fn try_from(value: binding::{rust_name}) -> AdapterResult<Self> {{"
                    ));
                    self.line(format_args!("        Ok(Self {{"));
                    for field in &record.fields {
                        let name = rust_field_name(&field.name);
                        let converted =
                            self.reverse_conversion(field.ty, &format!("value.{name}"))?;
                        self.line(format_args!("            {name}: {converted},"));
                    }
                    self.line(format_args!("        }})"));
                    self.line(format_args!("    }}"));
                    self.line(format_args!("}}"));
                }
                TypeDefKind::Enum(enumeration) => {
                    self.line(format_args!(
                        "impl From<neutral::{rust_name}> for binding::{rust_name} {{"
                    ));
                    self.line(format_args!(
                        "    fn from(value: neutral::{rust_name}) -> Self {{"
                    ));
                    self.line(format_args!("        match value {{"));
                    for case in &enumeration.cases {
                        let case = rust_type_name(&case.name)?;
                        self.line(format_args!(
                            "            neutral::{rust_name}::{case} => Self::{case},"
                        ));
                    }
                    self.line(format_args!("        }}"));
                    self.line(format_args!("    }}"));
                    self.line(format_args!("}}"));
                    self.line(format_args!(""));
                    self.line(format_args!(
                        "impl TryFrom<binding::{rust_name}> for neutral::{rust_name} {{"
                    ));
                    self.line(format_args!("    type Error = SdkError;"));
                    self.line(format_args!(
                        "    fn try_from(value: binding::{rust_name}) -> AdapterResult<Self> {{"
                    ));
                    self.line(format_args!("        Ok(match value {{"));
                    for case in &enumeration.cases {
                        let case = rust_type_name(&case.name)?;
                        self.line(format_args!(
                            "            binding::{rust_name}::{case} => Self::{case},"
                        ));
                    }
                    self.line(format_args!("        }})"));
                    self.line(format_args!("    }}"));
                    self.line(format_args!("}}"));
                }
                TypeDefKind::Variant(variant) => {
                    self.line(format_args!(
                        "impl From<neutral::{rust_name}> for binding::{rust_name} {{"
                    ));
                    self.line(format_args!(
                        "    fn from(value: neutral::{rust_name}) -> Self {{"
                    ));
                    self.line(format_args!("        match value {{"));
                    for case in &variant.cases {
                        let case_name = rust_type_name(&case.name)?;
                        match case.ty {
                            Some(ty) => {
                                let converted = self.forward_conversion(ty, "payload")?;
                                self.line(format_args!(
                                    "            neutral::{rust_name}::{case_name}(payload) => Self::{case_name}({converted}),"
                                ));
                            }
                            None => self.line(format_args!(
                                "            neutral::{rust_name}::{case_name}(()) => Self::{case_name},"
                            )),
                        }
                    }
                    self.line(format_args!("        }}"));
                    self.line(format_args!("    }}"));
                    self.line(format_args!("}}"));
                    self.line(format_args!(""));
                    self.line(format_args!(
                        "impl TryFrom<binding::{rust_name}> for neutral::{rust_name} {{"
                    ));
                    self.line(format_args!("    type Error = SdkError;"));
                    self.line(format_args!(
                        "    fn try_from(value: binding::{rust_name}) -> AdapterResult<Self> {{"
                    ));
                    self.line(format_args!("        Ok(match value {{"));
                    for case in &variant.cases {
                        let case_name = rust_type_name(&case.name)?;
                        match case.ty {
                            Some(ty) => {
                                let converted = self.reverse_conversion(ty, "payload")?;
                                self.line(format_args!(
                                    "            binding::{rust_name}::{case_name}(payload) => Self::{case_name}({converted}),"
                                ));
                            }
                            None => self.line(format_args!(
                                "            binding::{rust_name}::{case_name} => Self::{case_name}(()),"
                            )),
                        }
                    }
                    self.line(format_args!("        }})"));
                    self.line(format_args!("    }}"));
                    self.line(format_args!("}}"));
                }
                TypeDefKind::Type(_) => continue,
                unsupported => {
                    return Err(CodegenError(format!(
                        "unsupported adapter WIT type `{wit_name}`: {unsupported:?}"
                    )));
                }
            }
            self.line(format_args!(""));
        }
        Ok(())
    }

    fn forward_conversion(&self, ty: Type, expression: &str) -> Result<String> {
        match ty {
            Type::Bool
            | Type::U8
            | Type::U16
            | Type::U32
            | Type::U64
            | Type::S8
            | Type::S16
            | Type::S32
            | Type::S64
            | Type::Char
            | Type::String => Ok(expression.into()),
            Type::Id(id) => {
                let definition = &self.resolve.types[id];
                if definition.name.as_deref() == Some("byte-list") {
                    return Ok(format!("{expression}.into_vec()"));
                }
                if definition.name.is_some() {
                    return match &definition.kind {
                        TypeDefKind::Record(_) | TypeDefKind::Enum(_) | TypeDefKind::Variant(_) => {
                            Ok(format!("{expression}.into()"))
                        }
                        TypeDefKind::Type(inner) => self.forward_conversion(*inner, expression),
                        unsupported => Err(CodegenError(format!(
                            "unsupported named adapter conversion: {unsupported:?}"
                        ))),
                    };
                }
                match &definition.kind {
                    TypeDefKind::Option(inner) => {
                        if self.needs_conversion(*inner)? {
                            let converted = self.forward_conversion(*inner, "value")?;
                            Ok(format!("{expression}.map(|value| {converted})"))
                        } else {
                            Ok(expression.into())
                        }
                    }
                    TypeDefKind::List(Type::U8) => Ok(format!("{expression}.into_vec()")),
                    TypeDefKind::List(inner) => {
                        if self.needs_conversion(*inner)? {
                            let converted = self.forward_conversion(*inner, "value")?;
                            Ok(format!(
                                "{expression}.into_iter().map(|value| {converted}).collect()"
                            ))
                        } else {
                            Ok(expression.into())
                        }
                    }
                    unsupported => Err(CodegenError(format!(
                        "unsupported anonymous adapter conversion: {unsupported:?}"
                    ))),
                }
            }
            unsupported => Err(CodegenError(format!(
                "unsupported scalar adapter conversion: {unsupported:?}"
            ))),
        }
    }

    fn reverse_conversion(&self, ty: Type, expression: &str) -> Result<String> {
        match ty {
            Type::Bool
            | Type::U8
            | Type::U16
            | Type::U32
            | Type::U64
            | Type::S8
            | Type::S16
            | Type::S32
            | Type::S64
            | Type::Char
            | Type::String => Ok(expression.into()),
            Type::Id(id) => {
                let definition = &self.resolve.types[id];
                if definition.name.as_deref() == Some("byte-list") {
                    return Ok(format!("neutral::ByteList::new({expression})?"));
                }
                if definition.name.is_some() {
                    return match &definition.kind {
                        TypeDefKind::Record(_) | TypeDefKind::Enum(_) | TypeDefKind::Variant(_) => {
                            Ok(format!("{expression}.try_into()?"))
                        }
                        TypeDefKind::Type(inner) => self.reverse_conversion(*inner, expression),
                        unsupported => Err(CodegenError(format!(
                            "unsupported named adapter conversion: {unsupported:?}"
                        ))),
                    };
                }
                match &definition.kind {
                    TypeDefKind::Option(inner) => {
                        if self.needs_conversion(*inner)? {
                            let converted = self.reverse_conversion(*inner, "value")?;
                            Ok(format!(
                                "match {expression} {{ Some(value) => Some({converted}), None => None }}"
                            ))
                        } else {
                            Ok(expression.into())
                        }
                    }
                    TypeDefKind::List(Type::U8) => {
                        Ok(format!("neutral::ByteList::new({expression})?"))
                    }
                    TypeDefKind::List(inner) => {
                        if self.needs_conversion(*inner)? {
                            let converted = self.reverse_conversion(*inner, "value")?;
                            Ok(format!(
                                "{expression}.into_iter().map(|value| -> AdapterResult<_> {{ Ok({converted}) }}).collect::<AdapterResult<Vec<_>>>()?"
                            ))
                        } else {
                            Ok(expression.into())
                        }
                    }
                    unsupported => Err(CodegenError(format!(
                        "unsupported anonymous adapter conversion: {unsupported:?}"
                    ))),
                }
            }
            unsupported => Err(CodegenError(format!(
                "unsupported scalar adapter conversion: {unsupported:?}"
            ))),
        }
    }

    fn needs_conversion(&self, ty: Type) -> Result<bool> {
        match ty {
            Type::Bool
            | Type::U8
            | Type::U16
            | Type::U32
            | Type::U64
            | Type::S8
            | Type::S16
            | Type::S32
            | Type::S64
            | Type::Char
            | Type::String => Ok(false),
            Type::Id(id) => {
                let definition = &self.resolve.types[id];
                if definition.name.as_deref() == Some("byte-list") {
                    return Ok(true);
                }
                if definition.name.is_some() {
                    return match &definition.kind {
                        TypeDefKind::Record(_) | TypeDefKind::Enum(_) | TypeDefKind::Variant(_) => {
                            Ok(true)
                        }
                        TypeDefKind::Type(inner) => self.needs_conversion(*inner),
                        unsupported => Err(CodegenError(format!(
                            "unsupported named adapter type: {unsupported:?}"
                        ))),
                    };
                }
                match &definition.kind {
                    TypeDefKind::List(Type::U8) => Ok(true),
                    TypeDefKind::Option(inner) | TypeDefKind::List(inner) => {
                        self.needs_conversion(*inner)
                    }
                    unsupported => Err(CodegenError(format!(
                        "unsupported anonymous adapter type: {unsupported:?}"
                    ))),
                }
            }
            unsupported => Err(CodegenError(format!(
                "unsupported scalar adapter type: {unsupported:?}"
            ))),
        }
    }

    fn named_types(&mut self, interface_id: InterfaceId) -> Result<()> {
        let interface = &self.resolve.interfaces[interface_id];
        for (wit_name, type_id) in &interface.types {
            let definition = &self.resolve.types[*type_id];
            if definition.name.as_deref() != Some(wit_name) {
                return Err(CodegenError(format!(
                    "type identity drift for `{wit_name}`"
                )));
            }
            let rust_name = rust_type_name(wit_name)?;
            match &definition.kind {
                TypeDefKind::Type(ty) => {
                    let rendered = self.render_type(*ty)?;
                    self.line(format_args!("pub type {rust_name} = {rendered};"));
                }
                TypeDefKind::Record(record) => {
                    self.line(format_args!(
                        "#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]"
                    ));
                    self.line(format_args!("#[serde(deny_unknown_fields)]"));
                    self.line(format_args!("pub struct {rust_name} {{"));
                    for field in &record.fields {
                        self.line(format_args!("    #[serde(rename = \"{}\")]", field.name));
                        if self.is_option(field.ty) {
                            self.line(format_args!(
                                "    #[serde(deserialize_with = \"deserialize_present_option\")]"
                            ));
                        }
                        let field_name = rust_field_name(&field.name);
                        let ty = self.render_type(field.ty)?;
                        self.line(format_args!("    pub {field_name}: {ty},"));
                    }
                    self.line(format_args!("}}"));
                }
                TypeDefKind::Variant(variant) => {
                    self.line(format_args!(
                        "#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]"
                    ));
                    self.line(format_args!(
                        "#[serde(tag = \"tag\", content = \"val\", deny_unknown_fields)]"
                    ));
                    self.line(format_args!("pub enum {rust_name} {{"));
                    for case in &variant.cases {
                        let case_name = rust_type_name(&case.name)?;
                        let payload = case
                            .ty
                            .map(|ty| self.render_type(ty))
                            .transpose()?
                            .unwrap_or_else(|| "()".into());
                        self.line(format_args!("    #[serde(rename = \"{}\")]", case.name));
                        self.line(format_args!("    {case_name}({payload}),"));
                    }
                    self.line(format_args!("}}"));
                }
                TypeDefKind::Enum(enumeration) => {
                    self.line(format_args!(
                        "#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]"
                    ));
                    self.line(format_args!("pub enum {rust_name} {{"));
                    for case in &enumeration.cases {
                        let case_name = rust_type_name(&case.name)?;
                        self.line(format_args!("    #[serde(rename = \"{}\")]", case.name));
                        self.line(format_args!("    {case_name},"));
                    }
                    self.line(format_args!("}}"));
                }
                unsupported => {
                    return Err(CodegenError(format!(
                        "unsupported named WIT type `{wit_name}`: {unsupported:?}"
                    )));
                }
            }
            self.line(format_args!(""));
        }
        Ok(())
    }

    fn result_type(&mut self) {
        self.line(format_args!(
            "#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]"
        ));
        self.line(format_args!(
            "#[serde(tag = \"tag\", content = \"val\", deny_unknown_fields)]"
        ));
        self.line(format_args!("pub enum WitResult<T, E> {{"));
        self.line(format_args!("    #[serde(rename = \"ok\")]"));
        self.line(format_args!("    Ok(T),"));
        self.line(format_args!("    #[serde(rename = \"err\")]"));
        self.line(format_args!("    Err(E),"));
        self.line(format_args!("}}"));
        self.line(format_args!(""));
        self.line(format_args!("impl<T, E> WitResult<T, E> {{"));
        self.line(format_args!(
            "    pub fn into_result(self) -> std::result::Result<T, E> {{"
        ));
        self.line(format_args!("        match self {{"));
        self.line(format_args!("            Self::Ok(value) => Ok(value),"));
        self.line(format_args!("            Self::Err(error) => Err(error),"));
        self.line(format_args!("        }}"));
        self.line(format_args!("    }}"));
        self.line(format_args!("}}"));
        self.line(format_args!(""));
    }

    fn function_adapters(&mut self, interface_name: &str, interface_id: InterfaceId) -> Result<()> {
        let functions = self.resolve.interfaces[interface_id]
            .functions
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for function in &functions {
            if interface_name == "guest" {
                self.guest_function_adapter(function)?;
            } else if interface_name.starts_with("host-") {
                self.host_function_adapter(interface_name, function)?;
            } else {
                return Err(CodegenError(format!(
                    "unexpected function interface `{interface_name}`"
                )));
            }
        }
        Ok(())
    }

    fn guest_function_adapter(&mut self, function: &Function) -> Result<()> {
        let Some((context, arguments)) = function.params.split_first() else {
            return Err(CodegenError(format!(
                "guest function `{}` has no context",
                function.name
            )));
        };
        if context.name != "context" || self.render_type(context.ty)? != "InvocationContext" {
            return Err(CodegenError(format!(
                "guest function `{}` has unexpected context",
                function.name
            )));
        }
        let prefix = format!("Guest{}", rust_type_name(&function.name)?);
        match arguments {
            [] => self.line(format_args!("pub type {prefix}Argument = ();")),
            [argument] => {
                let ty = self.render_type(argument.ty)?;
                self.line(format_args!("pub type {prefix}Argument = {ty};"));
            }
            _ => {
                return Err(CodegenError(format!(
                    "guest function `{}` has multiple payload arguments",
                    function.name
                )));
            }
        }
        let result = self.render_optional_type(function.result)?;
        self.line(format_args!("pub type {prefix}Result = {result};"));
        self.line(format_args!(""));
        Ok(())
    }

    fn host_function_adapter(&mut self, interface_name: &str, function: &Function) -> Result<()> {
        let prefix = format!(
            "{}{}",
            rust_type_name(interface_name)?,
            rust_type_name(&function.name)?
        );
        match function.params.as_slice() {
            [] => self.line(format_args!("pub type {prefix}Arguments = ();")),
            [argument] => {
                let ty = self.render_type(argument.ty)?;
                self.line(format_args!("pub type {prefix}Arguments = {ty};"));
            }
            arguments => {
                self.line(format_args!(
                    "#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]"
                ));
                self.line(format_args!("#[serde(deny_unknown_fields)]"));
                self.line(format_args!("pub struct {prefix}Arguments {{"));
                for argument in arguments {
                    self.line(format_args!("    #[serde(rename = \"{}\")]", argument.name));
                    if self.is_option(argument.ty) {
                        self.line(format_args!(
                            "    #[serde(deserialize_with = \"deserialize_present_option\")]"
                        ));
                    }
                    let name = rust_field_name(&argument.name);
                    let ty = self.render_type(argument.ty)?;
                    self.line(format_args!("    pub {name}: {ty},"));
                }
                self.line(format_args!("}}"));
            }
        }
        let result = self.render_optional_type(function.result)?;
        self.line(format_args!("pub type {prefix}Result = {result};"));
        self.line(format_args!(""));
        Ok(())
    }

    fn render_optional_type(&self, ty: Option<Type>) -> Result<String> {
        ty.map(|ty| self.render_type(ty))
            .transpose()
            .map(|ty| ty.unwrap_or_else(|| "()".into()))
    }

    fn render_type(&self, ty: Type) -> Result<String> {
        match ty {
            Type::Bool => Ok("bool".into()),
            Type::U8 => Ok("u8".into()),
            Type::U16 => Ok("u16".into()),
            Type::U32 => Ok("u32".into()),
            Type::U64 => Ok("u64".into()),
            Type::S8 => Ok("i8".into()),
            Type::S16 => Ok("i16".into()),
            Type::S32 => Ok("i32".into()),
            Type::S64 => Ok("i64".into()),
            Type::String => Ok("String".into()),
            Type::Id(id) => {
                let definition = &self.resolve.types[id];
                if let Some(name) = &definition.name {
                    return rust_type_name(name);
                }
                match &definition.kind {
                    TypeDefKind::Option(inner) => {
                        Ok(format!("Option<{}>", self.render_type(*inner)?))
                    }
                    TypeDefKind::List(Type::U8) => Ok("ByteList".into()),
                    TypeDefKind::List(inner) => Ok(format!("Vec<{}>", self.render_type(*inner)?)),
                    TypeDefKind::Result(result) => Ok(format!(
                        "WitResult<{}, {}>",
                        self.render_optional_type(result.ok)?,
                        self.render_optional_type(result.err)?
                    )),
                    TypeDefKind::Tuple(tuple) => {
                        let mut rendered = tuple
                            .types
                            .iter()
                            .map(|ty| self.render_type(*ty))
                            .collect::<Result<Vec<_>>>()?;
                        if rendered.len() == 1 {
                            rendered[0].push(',');
                        }
                        Ok(format!("({})", rendered.join(", ")))
                    }
                    unsupported => Err(CodegenError(format!(
                        "unsupported anonymous WIT type: {unsupported:?}"
                    ))),
                }
            }
            unsupported => Err(CodegenError(format!(
                "unsupported scalar WIT type: {unsupported:?}"
            ))),
        }
    }

    fn is_option(&self, ty: Type) -> bool {
        match ty {
            Type::Id(id) => match &self.resolve.types[id].kind {
                TypeDefKind::Option(_) => true,
                TypeDefKind::Type(inner) => self.is_option(*inner),
                _ => false,
            },
            _ => false,
        }
    }
}

fn rust_type_name(wit_name: &str) -> Result<String> {
    let mut rendered = String::new();
    for part in wit_name.trim_start_matches('%').split('-') {
        let mut characters = part.chars();
        let Some(first) = characters.next() else {
            return Err(CodegenError(format!("invalid WIT identifier `{wit_name}`")));
        };
        rendered.extend(first.to_uppercase());
        rendered.extend(characters);
    }
    if rendered.is_empty() {
        Err(CodegenError(format!(
            "invalid empty WIT identifier `{wit_name}`"
        )))
    } else {
        Ok(rendered)
    }
}

fn rust_field_name(wit_name: &str) -> String {
    let name = wit_name.trim_start_matches('%').replace('-', "_");
    if matches!(
        name.as_str(),
        "as" | "async"
            | "await"
            | "break"
            | "const"
            | "continue"
            | "crate"
            | "dyn"
            | "else"
            | "enum"
            | "extern"
            | "false"
            | "fn"
            | "for"
            | "if"
            | "impl"
            | "in"
            | "let"
            | "loop"
            | "match"
            | "mod"
            | "move"
            | "mut"
            | "pub"
            | "ref"
            | "return"
            | "self"
            | "Self"
            | "static"
            | "struct"
            | "super"
            | "trait"
            | "true"
            | "type"
            | "unsafe"
            | "use"
            | "where"
            | "while"
    ) {
        format!("r#{name}")
    } else {
        name
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
        encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    encoded
}
