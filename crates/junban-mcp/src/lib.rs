//! Junban MCP library — persistent stdio adapter over `junban-cli` session foundations.

pub mod prompts;
pub mod resources;
pub mod server;
pub mod tools;

pub use server::{JunbanMcpServer, PrincipalDiscoveryHold, serve_stdio};
