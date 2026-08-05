//! Compile-time Component Model bindings for the one public plugin WIT.
//!
//! Slice 2A.1 uses only the generated value types for neutral-body adapters.
//! Linker construction, Store ownership, and guest execution remain Slice 2B.

#![allow(dead_code)]

wasmtime::component::bindgen!({
    path: "../junban-plugin-sdk/wit",
    world: "plugin",
});
