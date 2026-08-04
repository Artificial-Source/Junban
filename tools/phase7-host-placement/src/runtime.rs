//! TEMPORARY in-process Wasmtime 45.0.3 Component Model host for Wave 0.
//!
//! Minimal features only: runtime + cranelift + component-model + async, plus
//! wasmtime-wasi p2. No cache, GC collector suite, or parallel-compilation.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use thiserror::Error;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::child_ipc::Timings;
use crate::protocol::{ComponentKind, SpikeLimits};

wasmtime::component::bindgen!({
    path: "wit",
    world: "spike",
    // Sync guest exports; host may still use async config for WASI p2.
    imports: { default: async | trappable },
    exports: { default: async | trappable },
});

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("wasmtime: {0}")]
    Wasm(#[from] wasmtime::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("state: {0}")]
    State(String),
    #[error("guest trap or interrupt: {0}")]
    Guest(String),
}

struct HostState {
    ctx: WasiCtx,
    table: ResourceTable,
    limits: StoreLimits,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.ctx,
            table: &mut self.table,
        }
    }
}

/// Lazy in-process runtime. Constructing this type does **not** create an Engine.
pub struct SpikeRuntime {
    limits: SpikeLimits,
    component_kind: ComponentKind,
    engine: Option<Engine>,
    component: Option<Component>,
    store: Option<Store<HostState>>,
    instance: Option<Spike>,
}

impl SpikeRuntime {
    pub fn new(limits: SpikeLimits, component_kind: ComponentKind) -> Self {
        Self {
            limits,
            component_kind,
            engine: None,
            component: None,
            store: None,
            instance: None,
        }
    }

    pub fn has_engine(&self) -> bool {
        self.engine.is_some()
    }

    pub fn has_instance(&self) -> bool {
        self.instance.is_some()
    }

    pub fn create_engine(&mut self) -> Result<Timings, RuntimeError> {
        if self.engine.is_some() {
            return Err(RuntimeError::State("engine already exists".into()));
        }
        let started = Instant::now();
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.epoch_interruption(true);
        // On-demand allocation; pooling is out of scope for the spike.
        config.memory_init_cow(true);
        let engine = Engine::new(&config)?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        self.engine = Some(engine);
        Ok(Timings {
            engine_create_ms: Some(elapsed),
            total_ms: Some(elapsed),
            ..Timings::default()
        })
    }

    pub fn compile_component(&mut self, path: &Path) -> Result<Timings, RuntimeError> {
        let engine = self
            .engine
            .as_ref()
            .ok_or_else(|| RuntimeError::State("engine missing".into()))?;
        let started = Instant::now();
        let bytes = std::fs::read(path)?;
        let component = Component::new(engine, bytes)?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        self.component = Some(component);
        // Compiling replaces any prior instance.
        self.instance = None;
        self.store = None;
        Ok(Timings {
            compile_ms: Some(elapsed),
            total_ms: Some(elapsed),
            ..Timings::default()
        })
    }

    pub async fn instantiate(&mut self) -> Result<Timings, RuntimeError> {
        let engine = self
            .engine
            .as_ref()
            .ok_or_else(|| RuntimeError::State("engine missing".into()))?
            .clone();
        let component = self
            .component
            .as_ref()
            .ok_or_else(|| RuntimeError::State("component missing".into()))?
            .clone();

        let started = Instant::now();
        let mut linker = Linker::new(&engine);
        // Link only the declared toolchain baseline. Pure TypeScript spike components
        // (componentize-js --disable all) import nothing and must not force a broader
        // WASI surface. Rust wasm32-wasip2 guests need the empty-capability p2 baseline
        // (cli/io only in practice); no preopens, sockets, env inherit, or HTTP.
        if matches!(self.component_kind, ComponentKind::Rust) {
            wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        }

        let max_pages = match self.component_kind {
            ComponentKind::Rust => self.limits.rust_memory_pages,
            ComponentKind::Typescript => self.limits.typescript_memory_pages,
        };
        // StoreLimits pages are a hostile-probe safety cap, not a frozen product budget.
        let store_limits = StoreLimitsBuilder::new()
            .memory_size((max_pages as usize) * 64 * 1024)
            .memories(2)
            .tables(4)
            .instances(4)
            .trap_on_grow_failure(true)
            .build();

        // Default WasiCtxBuilder: stdin closed, stdout/stderr sink, empty env/args,
        // no preopens, no inherited network. Do not call inherit_* helpers.
        let wasi = WasiCtxBuilder::new().build();
        let state = HostState {
            ctx: wasi,
            table: ResourceTable::new(),
            limits: store_limits,
        };
        let mut store = Store::new(&engine, state);
        store.limiter(|s| &mut s.limits);
        // One epoch tick of budget; a background tick thread advances the engine epoch.
        store.set_epoch_deadline(1);

        let instance = Spike::instantiate_async(&mut store, &component, &linker).await?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        self.store = Some(store);
        self.instance = Some(instance);
        Ok(Timings {
            instantiate_ms: Some(elapsed),
            total_ms: Some(elapsed),
            ..Timings::default()
        })
    }

    pub async fn ping(&mut self, input: u32) -> Result<(u32, Timings), RuntimeError> {
        let started = Instant::now();
        let (store, instance) = self.store_instance_mut()?;
        store.set_epoch_deadline(1);
        let out = instance
            .call_ping(store, input)
            .await
            .map_err(|e| RuntimeError::Guest(e.to_string()))?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        Ok((
            out,
            Timings {
                first_call_ms: Some(elapsed),
                total_ms: Some(elapsed),
                ..Timings::default()
            },
        ))
    }

    pub async fn warm_ping(
        &mut self,
        input: u32,
        iterations: u32,
    ) -> Result<(u32, Timings), RuntimeError> {
        if iterations == 0 {
            return Err(RuntimeError::State("iterations must be > 0".into()));
        }
        let mut last = 0_u32;
        let started = Instant::now();
        for _ in 0..iterations {
            let (store, instance) = self.store_instance_mut()?;
            store.set_epoch_deadline(1);
            last = instance
                .call_ping(store, input)
                .await
                .map_err(|e| RuntimeError::Guest(e.to_string()))?;
        }
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let per = elapsed / f64::from(iterations);
        Ok((
            last,
            Timings {
                warm_call_ms: Some(per),
                total_ms: Some(elapsed),
                ..Timings::default()
            },
        ))
    }

    pub async fn force_trap(&mut self) -> Result<Timings, RuntimeError> {
        let started = Instant::now();
        let (store, instance) = self.store_instance_mut()?;
        store.set_epoch_deadline(1);
        let result = instance.call_force_trap(store).await;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        // Trap destroys this instance; drop it so the host stays usable.
        self.instance = None;
        self.store = None;
        match result {
            Ok(()) => Err(RuntimeError::State(
                "force-trap returned successfully; expected trap".into(),
            )),
            Err(err) => Ok(Timings {
                terminate_ms: Some(elapsed),
                total_ms: Some(elapsed),
                ..Timings::default()
            }
            .with_detail_ignored(err.to_string())),
        }
    }

    pub async fn cpu_loop(&mut self) -> Result<Timings, RuntimeError> {
        let engine = self
            .engine
            .as_ref()
            .ok_or_else(|| RuntimeError::State("engine missing".into()))?
            .clone();
        let deadline = Duration::from_millis(self.limits.epoch_deadline_ms.max(50));
        let tick = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let tick_flag = Arc::clone(&tick);
        let engine_tick = engine.clone();
        let joiner = std::thread::spawn(move || {
            while tick_flag.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(10));
                engine_tick.increment_epoch();
            }
        });

        let started = Instant::now();
        let (store, instance) = self.store_instance_mut()?;
        // Small deadline; ticker will trip it quickly once the loop runs.
        store.set_epoch_deadline(1);
        let result = instance.call_cpu_loop(store).await;
        tick.store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = joiner.join();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        self.instance = None;
        self.store = None;
        match result {
            Ok(()) => Err(RuntimeError::State(
                "cpu-loop returned; expected epoch interrupt".into(),
            )),
            Err(err) => {
                if started.elapsed() > deadline + Duration::from_millis(2_000) {
                    return Err(RuntimeError::Guest(format!(
                        "cpu-loop not interrupted promptly ({elapsed:.1} ms): {err}"
                    )));
                }
                Ok(Timings {
                    terminate_ms: Some(elapsed),
                    total_ms: Some(elapsed),
                    ..Timings::default()
                })
            }
        }
    }

    pub async fn grow_memory(&mut self, pages: u32) -> Result<(u32, Timings), RuntimeError> {
        let started = Instant::now();
        let (store, instance) = self.store_instance_mut()?;
        store.set_epoch_deadline(1);
        let result = instance.call_grow_memory(store, pages).await;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(Ok(bytes)) => Ok((
                bytes,
                Timings {
                    total_ms: Some(elapsed),
                    ..Timings::default()
                },
            )),
            Ok(Err(msg)) => {
                // Guest-reported limit — instance may still be alive.
                Err(RuntimeError::Guest(msg))
            }
            Err(err) => {
                // Trap on grow failure discards instance.
                self.instance = None;
                self.store = None;
                Err(RuntimeError::Guest(err.to_string()))
            }
        }
    }

    pub fn drop_instance(&mut self) -> Timings {
        let started = Instant::now();
        self.instance = None;
        self.store = None;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        Timings {
            terminate_ms: Some(elapsed),
            total_ms: Some(elapsed),
            ..Timings::default()
        }
    }

    pub fn drop_engine(&mut self) -> Timings {
        let started = Instant::now();
        self.instance = None;
        self.store = None;
        self.component = None;
        self.engine = None;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        Timings {
            terminate_ms: Some(elapsed),
            total_ms: Some(elapsed),
            ..Timings::default()
        }
    }

    fn store_instance_mut(&mut self) -> Result<(&mut Store<HostState>, &Spike), RuntimeError> {
        let store = self
            .store
            .as_mut()
            .ok_or_else(|| RuntimeError::State("store/instance missing".into()))?;
        let instance = self
            .instance
            .as_ref()
            .ok_or_else(|| RuntimeError::State("store/instance missing".into()))?;
        Ok((store, instance))
    }
}

impl Timings {
    fn with_detail_ignored(self, _msg: String) -> Self {
        self
    }
}

/// Helper used by unit tests and the child host to run a full happy path.
pub async fn smoke_ping(component_path: &Path, kind: ComponentKind) -> Result<u32, RuntimeError> {
    let mut rt = SpikeRuntime::new(SpikeLimits::default(), kind);
    rt.create_engine()?;
    rt.compile_component(component_path)?;
    rt.instantiate().await?;
    let (out, _) = rt.ping(21).await?;
    Ok(out)
}

pub fn detail_ok(value: impl Into<serde_json::Value>) -> serde_json::Value {
    value.into()
}

pub fn detail_message(message: impl Into<String>) -> serde_json::Value {
    json!({ "message": message.into() })
}
