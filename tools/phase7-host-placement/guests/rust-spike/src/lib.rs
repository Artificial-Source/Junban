//! TEMPORARY non-public Phase 7 Wave 0 Rust spike guest component.

wit_bindgen::generate!({
    world: "spike",
    path: "../../wit",
});

use std::sync::Mutex;

/// Guest-owned buffer used to exercise linear-memory growth without host imports.
static GROWTH: Mutex<Vec<u8>> = Mutex::new(Vec::new());

struct Component;

impl Guest for Component {
    fn ping(input: u32) -> u32 {
        input.wrapping_add(21)
    }

    fn force_trap() {
        // Deliberate trap for hostile-containment measurement.
        unreachable!("junban p7 spike deliberate trap");
    }

    fn cpu_loop() {
        // Tight loop; host must epoch-interrupt.
        let mut x = 0_u64;
        loop {
            x = x.wrapping_add(1);
            std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
            if x == 0 {
                core::arch::wasm32::unreachable();
            }
        }
    }

    fn grow_memory(pages: u32) -> Result<u32, String> {
        let bytes = (pages as usize).saturating_mul(64 * 1024);
        if bytes == 0 {
            return Ok(GROWTH.lock().map_err(|e| e.to_string())?.len() as u32);
        }
        let mut guard = GROWTH.lock().map_err(|e| e.to_string())?;
        let new_len = guard.len().saturating_add(bytes);
        if new_len > (512 * 1024 * 1024) {
            return Err("guest soft cap 512MiB".into());
        }
        guard.try_reserve_exact(bytes).map_err(|e| e.to_string())?;
        guard.resize(new_len, 0xA5);
        if let Some(slot) = guard.last_mut() {
            *slot = 0x5A;
        }
        u32::try_from(guard.len()).map_err(|_| "length exceeds u32".into())
    }
}

export!(Component);
