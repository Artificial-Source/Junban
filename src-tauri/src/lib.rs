pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| Ok(()))
        .build(tauri::generate_context!())
        .expect("Failed to build ASF Junban.")
        .run(|_app, _event| {});
}
