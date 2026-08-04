//! TEMPORARY: print exact component import names as JSON for the Wave 0 harness.

use std::env;
use std::process::ExitCode;

use junban_phase7_host_placement::{
    MAX_COMPONENT_BYTES, RUST_BASELINE_IMPORTS, inspect_component_imports, rust_baseline_ok,
    typescript_pure_ok,
};
use serde_json::json;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let path = match args.next() {
        Some(p) => p,
        None => {
            eprintln!("usage: junban-p7-inspect-imports <component.wasm> [--kind rust|typescript]");
            return ExitCode::from(2);
        }
    };
    let mut kind = "unknown".to_string();
    while let Some(arg) = args.next() {
        if arg == "--kind" {
            kind = args.next().unwrap_or_else(|| "unknown".into());
        }
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            eprintln!("read error: {err}");
            return ExitCode::from(1);
        }
    };
    if bytes.len() > MAX_COMPONENT_BYTES {
        eprintln!(
            "component too large: {} > {MAX_COMPONENT_BYTES}",
            bytes.len()
        );
        return ExitCode::from(1);
    }
    let imports = match inspect_component_imports(&bytes) {
        Ok(i) => i,
        Err(err) => {
            eprintln!("inspect error: {err}");
            return ExitCode::from(1);
        }
    };
    let profile_ok = match kind.as_str() {
        "rust" => rust_baseline_ok(&imports),
        "typescript" | "ts" => typescript_pure_ok(&imports),
        _ => true,
    };
    let out = json!({
        "path": path,
        "kind": kind,
        "size_bytes": bytes.len(),
        "imports": imports,
        "expected_rust_baseline": RUST_BASELINE_IMPORTS,
        "profile_ok": profile_ok,
    });
    println!("{out}");
    if profile_ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(3)
    }
}
