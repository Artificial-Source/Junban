//! `junban-mcp` binary — persistent stdio MCP server.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use junban_cli::TargetOptions;
use junban_mcp::serve_stdio;

#[derive(Debug, Parser)]
#[command(name = "junban-mcp", version, about = "Junban MCP stdio server")]
struct Args {
    /// Private profile directory (defaults to the same path as junban-server).
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Explicit server base URL. Requires a credential file; never uses the operator token.
    #[arg(long)]
    server: Option<String>,
    /// Private credential file for explicit --server targets (or JUNBAN_CREDENTIAL_FILE).
    #[arg(long)]
    credential_file: Option<PathBuf>,
}

// Single-threaded runtime: MCP stdio handling is session-serialized, and the
// multi-thread allocator retained large freed schema arenas after tools/list.
// Server/CLI binaries keep their existing runtime flavor.
#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    // Diagnostics only on stderr — stdout is reserved for MCP frames.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_target(false)
        .compact()
        .init();

    let args = Args::parse();
    let options = TargetOptions::with_defaults(args.data_dir, args.server, args.credential_file);
    match serve_stdio(options).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("junban-mcp error: {error}");
            ExitCode::FAILURE
        }
    }
}
