//! Junban native CLI library: discovery, session, catalog, and command foundations.
//!
//! `junban-mcp` depends on this crate deliberately. No generic shared client crate.

pub mod auth;
pub mod catalog;
pub mod commands;
pub mod discovery;
pub mod error;
pub mod executor;
pub mod output;
pub mod render;
pub mod session;
pub mod status;

pub use catalog::{ToolAccess, ToolCatalog, ToolDefinition, catalog};
pub use discovery::TargetOptions;
pub use error::CliError;
pub use executor::{ExecutionResult, RequestPlan, plan_tool_call};
pub use output::OutputMode;
pub use session::{PrincipalCapabilities, Session, SessionMode};
pub use status::{StatusReport, collect_status, emit_status};
