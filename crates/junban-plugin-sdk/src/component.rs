use std::{
    collections::BTreeSet,
    io::{Read, Seek, SeekFrom},
};

use sha2::{Digest, Sha256};
use wasmparser::{
    Chunk, Encoding, FuncValidatorAllocations, Parser, Payload, ValidPayload, Validator,
    WasmFeatures,
};
use wit_parser::{
    Function, InterfaceId, Resolve, Type, TypeDefKind, WorldItem, decoding::DecodedWasm,
};

use crate::{
    authority::import_authority,
    error::{Result, SdkError},
    manifest::{Capability, RuntimeManifest, RuntimeProfile},
    package::COMPONENT_BYTES_MAX,
    util::{decode_hex_32, hex, put_u32},
};

pub const COMPONENT_AUTHORITY_METADATA_MAX: usize = 64 * 1024;
pub const COMPONENT_AUTHORITY_METADATA_SECTION_MAX: usize = 32 * 1024;
pub const COMPONENT_NESTING_MAX: usize = 32;
// StarlingMonkey's retained TypeScript profile has thousands of nested core
// sections; this remains a fixed pre-iteration ceiling rather than an unbounded walk.
pub const COMPONENT_SECTIONS_MAX: usize = 65_536;
pub const REQUIRED_GUEST_EXPORT: &str = "junban:plugin/guest@0.1.0";
pub const RUST_WASI_BASELINE: &[&str] = &[
    "wasi:cli/environment@0.2.6",
    "wasi:cli/exit@0.2.6",
    "wasi:cli/stderr@0.2.6",
    "wasi:io/error@0.2.6",
    "wasi:io/streams@0.2.6",
];
pub const RUST_WASI_ABI_SHA256: &[(&str, &str)] = &[
    (
        "wasi:cli/environment@0.2.6",
        "ff2daa4ad66d87df64e46fbdca0360a7e757dfc9ea546d7fad83310259294947",
    ),
    (
        "wasi:cli/exit@0.2.6",
        "946f1bb8c8fac1d522a3fc0adb07c4288be7be43018d7ac32c5591b5024efd46",
    ),
    (
        "wasi:cli/stderr@0.2.6",
        "2a3074042b3354f77e10acd8ec7ec41d4a99d0a11a5a2fc6977701d1cc08702f",
    ),
    (
        "wasi:io/error@0.2.6",
        "55715af05302db4a7253df123e35f8dd5df22f4c68dedb07673f8d8994abc454",
    ),
    (
        "wasi:io/streams@0.2.6",
        "4a00cb6646e72b260045e0f064db68f1629202aca581d6b1f445d896519bd100",
    ),
];
pub const WIT_SOURCE: &str = include_str!("../wit/plugin.wit");

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComponentInspection {
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub guest_abi_sha256: String,
    pub import_export_fingerprint: String,
    pub authority_metadata_bytes: u64,
}

pub fn inspect_component(
    component_bytes: &[u8],
    manifest: &RuntimeManifest,
) -> Result<ComponentInspection> {
    if component_bytes.is_empty() || component_bytes.len() > COMPONENT_BYTES_MAX {
        return Err(SdkError::Length { field: "component" });
    }
    require_component_encoding_and_metadata_bounds(component_bytes)?;
    Validator::new_with_features(WasmFeatures::all())
        .validate_all(component_bytes)
        .map_err(|_| SdkError::ComponentMalformed)?;
    let decoded =
        wit_parser::decoding::decode(component_bytes).map_err(|_| SdkError::ComponentMalformed)?;
    inspect_decoded_component(
        decoded,
        manifest,
        authority_metadata_bytes(component_bytes)?,
    )
}

/// Inspect a hard-capped component from a seekable source without requiring a
/// caller-owned component `Vec`.
///
/// The source is consumed only within `component_len`, then restored to its
/// initial position. A bounded first pass performs structural validation and
/// retains Junban's stricter nesting, section-count and custom-metadata ceilings
/// before the dependency decoder receives the already-validated capped input.
pub fn inspect_component_reader<R: Read + Seek>(
    reader: &mut R,
    component_len: u64,
    manifest: &RuntimeManifest,
) -> Result<ComponentInspection> {
    if component_len == 0 || component_len > COMPONENT_BYTES_MAX as u64 {
        return Err(SdkError::Length { field: "component" });
    }
    let start = reader
        .stream_position()
        .map_err(|_| SdkError::ComponentMalformed)?;
    let metadata_bytes = streaming_component_metadata(reader.take(component_len))?;
    reader
        .seek(SeekFrom::Start(start))
        .map_err(|_| SdkError::ComponentMalformed)?;
    let decoded = wit_parser::decoding::decode_reader(reader.take(component_len))
        .map_err(|_| SdkError::ComponentMalformed)?;
    reader
        .seek(SeekFrom::Start(start))
        .map_err(|_| SdkError::ComponentMalformed)?;
    inspect_decoded_component(decoded, manifest, metadata_bytes)
}

fn inspect_decoded_component(
    decoded: DecodedWasm,
    manifest: &RuntimeManifest,
    metadata_bytes: usize,
) -> Result<ComponentInspection> {
    let DecodedWasm::Component(resolve, world_id) = decoded else {
        return Err(SdkError::ComponentEncoding);
    };
    let world = &resolve.worlds[world_id];
    let mut imports = Vec::with_capacity(world.imports.len());
    for (key, item) in &world.imports {
        let WorldItem::Interface { id, .. } = item else {
            return Err(SdkError::ComponentAuthority {
                field: "non-interface import",
            });
        };
        let name = resolve.name_world_key(key);
        if let Some(expected) = expected_import_fingerprint(&name)? {
            let actual = <[u8; 32]>::from(Sha256::digest(interface_fingerprint(&resolve, *id)?));
            if actual != expected {
                return Err(SdkError::ComponentAuthority {
                    field: "import ABI",
                });
            }
        }
        imports.push(name);
    }
    imports.sort();
    if imports.windows(2).any(|window| window[0] == window[1]) {
        return Err(SdkError::ComponentAuthority {
            field: "duplicate import",
        });
    }

    let mut exports = Vec::with_capacity(world.exports.len());
    let mut guest_interface = None;
    for (key, item) in &world.exports {
        let name = resolve.name_world_key(key);
        if name == REQUIRED_GUEST_EXPORT {
            let WorldItem::Interface { id, .. } = item else {
                return Err(SdkError::ComponentAuthority {
                    field: "guest export kind",
                });
            };
            guest_interface = Some(id);
        }
        exports.push(name);
    }
    exports.sort();
    if exports != [REQUIRED_GUEST_EXPORT] {
        return Err(SdkError::ComponentAuthority { field: "exports" });
    }
    let guest_interface = guest_interface
        .copied()
        .ok_or(SdkError::ComponentAuthority {
            field: "guest export",
        })?;
    let actual_abi = interface_fingerprint(&resolve, guest_interface)?;
    let expected_abi = expected_guest_fingerprint()?;
    if actual_abi != expected_abi {
        return Err(SdkError::ComponentAuthority { field: "guest ABI" });
    }
    validate_imports(&imports, manifest)?;

    let guest_hash: [u8; 32] = Sha256::digest(&actual_abi).into();
    let mut combined = Vec::new();
    put_u32(&mut combined, imports.len())?;
    for import in &imports {
        put_u32(&mut combined, import.len())?;
        combined.extend_from_slice(import.as_bytes());
    }
    put_u32(&mut combined, exports.len())?;
    for export in &exports {
        put_u32(&mut combined, export.len())?;
        combined.extend_from_slice(export.as_bytes());
    }
    combined.extend_from_slice(&guest_hash);
    Ok(ComponentInspection {
        imports,
        exports,
        guest_abi_sha256: hex(&guest_hash),
        import_export_fingerprint: hex(&Sha256::digest(combined)),
        authority_metadata_bytes: u64::try_from(metadata_bytes).map_err(|_| SdkError::Length {
            field: "component metadata",
        })?,
    })
}

fn streaming_component_metadata(mut reader: impl Read) -> Result<usize> {
    let mut parser = Parser::new(0);
    let mut validator = Validator::new_with_features(WasmFeatures::all());
    let mut function_allocations = FuncValidatorAllocations::default();
    let mut parsers = Vec::new();
    let mut buffer = Vec::new();
    let mut eof = false;
    let mut first = true;
    let mut outer_component = false;
    let mut nesting = 0_usize;
    let mut sections = 0_usize;
    let mut metadata_bytes = 0_usize;

    loop {
        let (payload, consumed) = match parser
            .parse(&buffer, eof)
            .map_err(|_| SdkError::ComponentMalformed)?
        {
            Chunk::NeedMoreData(hint) => {
                if eof {
                    return Err(SdkError::ComponentMalformed);
                }
                let hint =
                    usize::try_from(hint).map_err(|_| SdkError::Length { field: "component" })?;
                let read_len = hint.clamp(1, 64 * 1024);
                let old_len = buffer.len();
                buffer.resize(
                    old_len
                        .checked_add(read_len)
                        .ok_or(SdkError::Length { field: "component" })?,
                    0,
                );
                let count = reader
                    .read(&mut buffer[old_len..])
                    .map_err(|_| SdkError::ComponentMalformed)?;
                buffer.truncate(old_len + count);
                eof = count == 0;
                continue;
            }
            Chunk::Parsed { consumed, payload } => (payload, consumed),
        };
        match validator
            .payload(&payload)
            .map_err(|_| SdkError::ComponentMalformed)?
        {
            ValidPayload::Func(function, body) => {
                let mut function = function.into_validator(function_allocations);
                function
                    .validate(&body)
                    .map_err(|_| SdkError::ComponentMalformed)?;
                function_allocations = function.into_allocations();
            }
            ValidPayload::Ok | ValidPayload::Parser(_) | ValidPayload::End(_) => {}
        }
        sections = sections.checked_add(1).ok_or(SdkError::Length {
            field: "component sections",
        })?;
        if sections > COMPONENT_SECTIONS_MAX {
            return Err(SdkError::ComponentAuthority {
                field: "component sections",
            });
        }
        if first {
            first = false;
            match payload {
                Payload::Version {
                    encoding: Encoding::Component,
                    ..
                } => outer_component = true,
                Payload::Version { .. } => return Err(SdkError::ComponentEncoding),
                _ => return Err(SdkError::ComponentMalformed),
            }
        } else {
            match &payload {
                Payload::ModuleSection { parser: nested, .. }
                | Payload::ComponentSection { parser: nested, .. } => {
                    nesting += 1;
                    if nesting > COMPONENT_NESTING_MAX {
                        return Err(SdkError::ComponentAuthority {
                            field: "component nesting",
                        });
                    }
                    parsers.push(parser.clone());
                    parser = nested.clone();
                }
                Payload::CustomSection(section) => {
                    let range = section.range();
                    let size = range.end.checked_sub(range.start).ok_or(SdkError::Length {
                        field: "component metadata",
                    })?;
                    if size > COMPONENT_AUTHORITY_METADATA_SECTION_MAX {
                        return Err(SdkError::ComponentAuthority {
                            field: "metadata section",
                        });
                    }
                    metadata_bytes = metadata_bytes.checked_add(size).ok_or(SdkError::Length {
                        field: "component metadata",
                    })?;
                    if metadata_bytes > COMPONENT_AUTHORITY_METADATA_MAX {
                        return Err(SdkError::ComponentAuthority {
                            field: "metadata aggregate",
                        });
                    }
                }
                Payload::End(_) => {
                    if let Some(parent) = parsers.pop() {
                        parser = parent;
                        nesting = nesting.saturating_sub(1);
                    } else {
                        buffer.drain(..consumed);
                        if !buffer.is_empty() || !eof {
                            let mut trailing = [0_u8; 1];
                            if !buffer.is_empty()
                                || reader
                                    .read(&mut trailing)
                                    .map_err(|_| SdkError::ComponentMalformed)?
                                    != 0
                            {
                                return Err(SdkError::ComponentMalformed);
                            }
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
        buffer.drain(..consumed);
    }
    if !outer_component {
        return Err(SdkError::ComponentEncoding);
    }
    Ok(metadata_bytes)
}

fn require_component_encoding_and_metadata_bounds(bytes: &[u8]) -> Result<()> {
    let mut first = true;
    let mut outer_component = false;
    let mut nesting = 0_usize;
    let mut sections = 0_usize;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|_| SdkError::ComponentMalformed)?;
        sections = sections.checked_add(1).ok_or(SdkError::Length {
            field: "component sections",
        })?;
        if sections > COMPONENT_SECTIONS_MAX {
            return Err(SdkError::ComponentAuthority {
                field: "component sections",
            });
        }
        match &payload {
            Payload::ModuleSection { .. } | Payload::ComponentSection { .. } => {
                nesting += 1;
                if nesting > COMPONENT_NESTING_MAX {
                    return Err(SdkError::ComponentAuthority {
                        field: "component nesting",
                    });
                }
            }
            Payload::End(_) if nesting > 0 => nesting -= 1,
            _ => {}
        }
        if first {
            first = false;
            match payload {
                Payload::Version {
                    encoding: Encoding::Component,
                    ..
                } => outer_component = true,
                Payload::Version { .. } => return Err(SdkError::ComponentEncoding),
                _ => return Err(SdkError::ComponentMalformed),
            }
        }
    }
    if !outer_component {
        return Err(SdkError::ComponentEncoding);
    }
    authority_metadata_bytes(bytes)?;
    Ok(())
}

fn authority_metadata_bytes(bytes: &[u8]) -> Result<usize> {
    let mut total = 0_usize;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|_| SdkError::ComponentMalformed)?;
        if let Payload::CustomSection(section) = payload {
            // Count full custom-section authority material: name bytes + data bytes.
            // wasmparser's range covers the exact payload (name length prefix + name + data).
            let range = section.range();
            let size = range.end.checked_sub(range.start).ok_or(SdkError::Length {
                field: "component metadata",
            })?;
            debug_assert!(size >= section.name().len().saturating_add(section.data().len()));
            if size > COMPONENT_AUTHORITY_METADATA_SECTION_MAX {
                return Err(SdkError::ComponentAuthority {
                    field: "metadata section",
                });
            }
            total = total.checked_add(size).ok_or(SdkError::Length {
                field: "component metadata",
            })?;
            if total > COMPONENT_AUTHORITY_METADATA_MAX {
                return Err(SdkError::ComponentAuthority {
                    field: "metadata aggregate",
                });
            }
        }
    }
    Ok(total)
}

fn validate_imports(imports: &[String], manifest: &RuntimeManifest) -> Result<()> {
    let capabilities = manifest.requested_capabilities();
    let mut wasi = Vec::new();
    for import in imports {
        if import.starts_with("wasi:") {
            wasi.push(import.as_str());
            continue;
        }
        let authority = import_authority(import).ok_or(SdkError::ComponentAuthority {
            field: "unknown import",
        })?;
        if authority
            .capability
            .is_some_and(|capability| !capabilities.contains(&capability))
        {
            return Err(SdkError::ComponentAuthority {
                field: "undeclared import",
            });
        }
    }
    match manifest.runtime_profile {
        RuntimeProfile::Typescript if wasi.is_empty() => Ok(()),
        RuntimeProfile::Rust if wasi == RUST_WASI_BASELINE => Ok(()),
        RuntimeProfile::Typescript | RuntimeProfile::Rust => Err(SdkError::ComponentAuthority {
            field: "runtime profile imports",
        }),
    }
}

fn embedded_contract() -> Result<(Resolve, wit_parser::PackageId)> {
    let mut resolve = Resolve::default();
    let package = resolve
        .push_str("junban-plugin.wit", WIT_SOURCE)
        .map_err(|_| SdkError::ComponentAuthority {
            field: "embedded WIT",
        })?;
    Ok((resolve, package))
}

fn expected_guest_fingerprint() -> Result<Vec<u8>> {
    let (resolve, package) = embedded_contract()?;
    let guest =
        *resolve.packages[package]
            .interfaces
            .get("guest")
            .ok_or(SdkError::ComponentAuthority {
                field: "embedded WIT guest",
            })?;
    interface_fingerprint(&resolve, guest)
}

fn expected_import_fingerprint(name: &str) -> Result<Option<[u8; 32]>> {
    if let Some(interface_name) = name
        .strip_prefix("junban:plugin/")
        .and_then(|name| name.strip_suffix("@0.1.0"))
    {
        let (resolve, package) = embedded_contract()?;
        let interface = *resolve.packages[package]
            .interfaces
            .get(interface_name)
            .ok_or(SdkError::ComponentAuthority {
                field: "unknown import",
            })?;
        let material = interface_fingerprint(&resolve, interface)?;
        return Ok(Some(Sha256::digest(material).into()));
    }
    RUST_WASI_ABI_SHA256
        .iter()
        .find_map(|(interface, fingerprint)| (*interface == name).then_some(*fingerprint))
        .map(|fingerprint| {
            decode_hex_32(fingerprint, "WASI ABI fingerprint").map_err(|_| {
                SdkError::ComponentAuthority {
                    field: "embedded WASI ABI",
                }
            })
        })
        .transpose()
}

fn interface_fingerprint(resolve: &Resolve, interface_id: InterfaceId) -> Result<Vec<u8>> {
    let interface = &resolve.interfaces[interface_id];
    let mut out = Vec::new();
    put_u32(&mut out, interface.functions.len())?;
    for (name, function) in &interface.functions {
        put_text(&mut out, name)?;
        function_fingerprint(resolve, function, &mut out)?;
    }
    Ok(out)
}

fn function_fingerprint(resolve: &Resolve, function: &Function, out: &mut Vec<u8>) -> Result<()> {
    use wit_parser::FunctionKind;
    match function.kind {
        FunctionKind::Freestanding => out.extend_from_slice(b"freestanding;"),
        FunctionKind::Method(resource) => {
            out.extend_from_slice(b"method;");
            type_fingerprint(resolve, Type::Id(resource), out, &mut BTreeSet::new())?;
        }
        FunctionKind::Static(resource) => {
            out.extend_from_slice(b"static;");
            type_fingerprint(resolve, Type::Id(resource), out, &mut BTreeSet::new())?;
        }
        FunctionKind::Constructor(resource) => {
            out.extend_from_slice(b"constructor;");
            type_fingerprint(resolve, Type::Id(resource), out, &mut BTreeSet::new())?;
        }
        FunctionKind::AsyncFreestanding
        | FunctionKind::AsyncMethod(_)
        | FunctionKind::AsyncStatic(_) => {
            return Err(SdkError::ComponentAuthority {
                field: "async function kind",
            });
        }
    }
    put_u32(out, function.params.len())?;
    for parameter in &function.params {
        put_text(out, &parameter.name)?;
        type_fingerprint(resolve, parameter.ty, out, &mut BTreeSet::new())?;
    }
    match function.result {
        Some(result) => {
            out.push(1);
            type_fingerprint(resolve, result, out, &mut BTreeSet::new())?;
        }
        None => out.push(0),
    }
    Ok(())
}

fn type_fingerprint(
    resolve: &Resolve,
    ty: Type,
    out: &mut Vec<u8>,
    visiting: &mut BTreeSet<usize>,
) -> Result<()> {
    match ty {
        Type::Bool => out.extend_from_slice(b"bool;"),
        Type::U8 => out.extend_from_slice(b"u8;"),
        Type::U16 => out.extend_from_slice(b"u16;"),
        Type::U32 => out.extend_from_slice(b"u32;"),
        Type::U64 => out.extend_from_slice(b"u64;"),
        Type::S8 => out.extend_from_slice(b"s8;"),
        Type::S16 => out.extend_from_slice(b"s16;"),
        Type::S32 => out.extend_from_slice(b"s32;"),
        Type::S64 => out.extend_from_slice(b"s64;"),
        Type::F32 | Type::F64 => return Err(SdkError::ComponentAuthority { field: "float ABI" }),
        Type::Char => out.extend_from_slice(b"char;"),
        Type::String => out.extend_from_slice(b"string;"),
        Type::ErrorContext => {
            return Err(SdkError::ComponentAuthority {
                field: "error-context ABI",
            });
        }
        Type::Id(id) => {
            if !visiting.insert(id.index()) {
                return Err(SdkError::ComponentAuthority {
                    field: "recursive ABI",
                });
            }
            let definition = &resolve.types[id];
            // A WIT `use` is a source-level alias. Component producers may retain
            // or erase that alias while preserving the same shared nominal type.
            if let TypeDefKind::Type(aliased) = &definition.kind {
                let result = type_fingerprint(resolve, *aliased, out, visiting);
                visiting.remove(&id.index());
                return result;
            }
            if let Some(name) = &definition.name {
                put_text(out, name)?;
            } else {
                put_text(out, "")?;
            }
            match &definition.kind {
                TypeDefKind::Record(record) => {
                    out.extend_from_slice(b"record;");
                    put_u32(out, record.fields.len())?;
                    for field in &record.fields {
                        put_text(out, &field.name)?;
                        type_fingerprint(resolve, field.ty, out, visiting)?;
                    }
                }
                TypeDefKind::Flags(flags) => {
                    out.extend_from_slice(b"flags;");
                    put_u32(out, flags.flags.len())?;
                    for flag in &flags.flags {
                        put_text(out, &flag.name)?;
                    }
                }
                TypeDefKind::Tuple(tuple) => {
                    out.extend_from_slice(b"tuple;");
                    put_u32(out, tuple.types.len())?;
                    for ty in &tuple.types {
                        type_fingerprint(resolve, *ty, out, visiting)?;
                    }
                }
                TypeDefKind::Variant(variant) => {
                    out.extend_from_slice(b"variant;");
                    put_u32(out, variant.cases.len())?;
                    for case in &variant.cases {
                        put_text(out, &case.name)?;
                        match case.ty {
                            Some(ty) => {
                                out.push(1);
                                type_fingerprint(resolve, ty, out, visiting)?;
                            }
                            None => out.push(0),
                        }
                    }
                }
                TypeDefKind::Enum(enumeration) => {
                    out.extend_from_slice(b"enum;");
                    put_u32(out, enumeration.cases.len())?;
                    for case in &enumeration.cases {
                        put_text(out, &case.name)?;
                    }
                }
                TypeDefKind::Option(ty) => {
                    out.extend_from_slice(b"option;");
                    type_fingerprint(resolve, *ty, out, visiting)?;
                }
                TypeDefKind::Result(result) => {
                    out.extend_from_slice(b"result;");
                    optional_type_fingerprint(resolve, result.ok, out, visiting)?;
                    optional_type_fingerprint(resolve, result.err, out, visiting)?;
                }
                TypeDefKind::List(ty) => {
                    out.extend_from_slice(b"list;");
                    type_fingerprint(resolve, *ty, out, visiting)?;
                }
                TypeDefKind::Type(_) => unreachable!("aliases returned above"),
                TypeDefKind::Resource => out.extend_from_slice(b"resource;"),
                TypeDefKind::Handle(handle) => {
                    match handle {
                        wit_parser::Handle::Own(_) => out.extend_from_slice(b"own;"),
                        wit_parser::Handle::Borrow(_) => out.extend_from_slice(b"borrow;"),
                    }
                    let resource = match handle {
                        wit_parser::Handle::Own(resource)
                        | wit_parser::Handle::Borrow(resource) => *resource,
                    };
                    type_fingerprint(resolve, Type::Id(resource), out, visiting)?;
                }
                TypeDefKind::Map(_, _)
                | TypeDefKind::FixedLengthList(_, _)
                | TypeDefKind::Future(_)
                | TypeDefKind::Stream(_)
                | TypeDefKind::Unknown => {
                    return Err(SdkError::ComponentAuthority {
                        field: "unsupported ABI type",
                    });
                }
            }
            visiting.remove(&id.index());
        }
    }
    Ok(())
}

fn optional_type_fingerprint(
    resolve: &Resolve,
    ty: Option<Type>,
    out: &mut Vec<u8>,
    visiting: &mut BTreeSet<usize>,
) -> Result<()> {
    match ty {
        Some(ty) => {
            out.push(1);
            type_fingerprint(resolve, ty, out, visiting)
        }
        None => {
            out.push(0);
            Ok(())
        }
    }
}

fn put_text(out: &mut Vec<u8>, text: &str) -> Result<()> {
    put_u32(out, text.len())?;
    out.extend_from_slice(text.as_bytes());
    Ok(())
}

#[must_use]
pub fn capability_for_import(interface: &str) -> Option<Option<Capability>> {
    import_authority(interface).map(|authority| authority.capability)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn leb(mut value: usize, output: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            output.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn append_custom_section(component: &mut Vec<u8>, name: &[u8], data_len: usize) {
        let mut payload = Vec::new();
        leb(name.len(), &mut payload);
        payload.extend_from_slice(name);
        payload.resize(payload.len() + data_len, 0);
        component.push(0);
        leb(payload.len(), component);
        component.extend_from_slice(&payload);
    }

    fn bare_component() -> Vec<u8> {
        b"\0asm\x0d\0\x01\0".to_vec()
    }

    #[test]
    fn custom_section_name_bytes_count_toward_section_and_aggregate_bounds() {
        // Oversized unknown name alone (near-empty data) must hit the per-section cap.
        let mut oversized_name = bare_component();
        let name = vec![b'n'; COMPONENT_AUTHORITY_METADATA_SECTION_MAX + 1];
        append_custom_section(&mut oversized_name, &name, 0);
        let oversized_error = Err(SdkError::ComponentAuthority {
            field: "metadata section",
        });
        assert_eq!(authority_metadata_bytes(&oversized_name), oversized_error);
        assert_eq!(
            streaming_component_metadata(Cursor::new(&oversized_name)),
            oversized_error
        );

        // Data alone stays under the 64 KiB aggregate, but counting name bytes
        // (plus name-length prefixes in the custom-section payload range) exceeds it.
        let long_name = vec![b'n'; 64]; // single-byte LEB name length
        let name_len_leb = 1_usize;
        let data_each = COMPONENT_AUTHORITY_METADATA_SECTION_MAX - name_len_leb - long_name.len();
        let section_size = name_len_leb + long_name.len() + data_each;
        assert_eq!(section_size, COMPONENT_AUTHORITY_METADATA_SECTION_MAX);
        let mut aggregate_names = bare_component();
        append_custom_section(&mut aggregate_names, &long_name, data_each);
        append_custom_section(&mut aggregate_names, &long_name, data_each);
        append_custom_section(&mut aggregate_names, &long_name, 0);
        let data_only = data_each.checked_mul(2).unwrap();
        assert!(data_only <= COMPONENT_AUTHORITY_METADATA_MAX);
        let counted = section_size
            .checked_mul(2)
            .and_then(|value| value.checked_add(name_len_leb + long_name.len()))
            .unwrap();
        assert!(counted > COMPONENT_AUTHORITY_METADATA_MAX);
        assert_eq!(
            authority_metadata_bytes(&aggregate_names),
            Err(SdkError::ComponentAuthority {
                field: "metadata aggregate",
            })
        );

        // Ordinary small name/producers sections still admit under both caps.
        let mut ordinary = bare_component();
        append_custom_section(&mut ordinary, b"name", 16);
        append_custom_section(&mut ordinary, b"producers", 16);
        let total = authority_metadata_bytes(&ordinary).unwrap();
        assert_eq!(
            streaming_component_metadata(Cursor::new(&ordinary)).unwrap(),
            total
        );
        assert!(total > 32);
        assert!(total <= COMPONENT_AUTHORITY_METADATA_MAX);

        // Bounds helper is reached from the public inspection pre-check path too.
        let mut encoded = bare_component();
        append_custom_section(
            &mut encoded,
            b"unknown-metadata",
            COMPONENT_AUTHORITY_METADATA_SECTION_MAX + 1,
        );
        assert!(matches!(
            require_component_encoding_and_metadata_bounds(&encoded),
            Err(SdkError::ComponentAuthority {
                field: "metadata section"
            })
        ));
    }
}
