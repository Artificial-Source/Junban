//! Compile-time Component Model bindings for the one public plugin WIT.

#![allow(dead_code)]

wasmtime::component::bindgen!({
    path: "../junban-plugin-sdk/wit/plugin.wit",
    inline: r#"
        package junban:host-runtime@0.1.0;

        world runtime {
            include junban:plugin/plugin@0.1.0;
            import junban:plugin/types@0.1.0;
            import junban:plugin/host-tasks@0.1.0;
            import junban:plugin/host-projects@0.1.0;
            import junban:plugin/host-tags@0.1.0;
            import junban:plugin/host-settings@0.1.0;
            import junban:plugin/host-storage@0.1.0;
            import junban:plugin/host-clock@0.1.0;
            import junban:plugin/host-http@0.1.0;
            import junban:plugin/host-log@0.1.0;
            import junban:plugin/host-services@0.1.0;
        }
    "#,
    world: "junban:host-runtime/runtime@0.1.0",
    imports: { default: trappable },
    require_store_data_send: true,
});
