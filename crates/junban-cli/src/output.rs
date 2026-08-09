//! Human and strict-JSON stdout discipline.

use std::io::{self, Write};

use serde::Serialize;

use crate::error::{CliError, EXIT_SUCCESS};

/// Whether the process should emit one JSON value on stdout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Human,
    Json,
}

/// Write one success JSON value and nothing else to stdout.
pub fn write_json_success(value: &impl Serialize) -> Result<(), CliError> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)
        .map_err(|error| CliError::runtime("json_encode_failed", error.to_string()))?;
    stdout
        .write_all(b"\n")
        .map_err(|error| CliError::runtime("stdout_write_failed", error.to_string()))?;
    stdout
        .flush()
        .map_err(|error| CliError::runtime("stdout_flush_failed", error.to_string()))?;
    Ok(())
}

/// Write one error JSON value to stdout for `--json` failures.
pub fn write_json_error(error: &CliError) -> Result<(), CliError> {
    write_json_success(&error.to_json())
}

/// Write a human-readable line to stdout.
pub fn write_human_line(line: &str) -> Result<(), CliError> {
    write_human_text(line)
}

/// Write multi-line human text to stdout with a single trailing newline.
pub fn write_human_text(text: &str) -> Result<(), CliError> {
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(text.as_bytes())
        .map_err(|error| CliError::runtime("stdout_write_failed", error.to_string()))?;
    if !text.ends_with('\n') {
        stdout
            .write_all(b"\n")
            .map_err(|error| CliError::runtime("stdout_write_failed", error.to_string()))?;
    }
    stdout
        .flush()
        .map_err(|error| CliError::runtime("stdout_flush_failed", error.to_string()))?;
    Ok(())
}

/// Write diagnostics exclusively to stderr.
pub fn write_stderr(message: &str) {
    let mut stderr = io::stderr().lock();
    let _ = writeln!(stderr, "{message}");
    let _ = stderr.flush();
}

/// Render a CLI result according to output mode and map to a process exit code.
pub fn finish_result<T: Serialize>(
    mode: OutputMode,
    result: Result<T, CliError>,
    render_human: impl FnOnce(&T) -> Result<(), CliError>,
) -> i32 {
    match (mode, result) {
        (OutputMode::Json, Ok(value)) => match write_json_success(&value) {
            Ok(()) => EXIT_SUCCESS,
            Err(error) => {
                write_stderr(&error.to_string());
                error.exit_code()
            }
        },
        (OutputMode::Human, Ok(value)) => match render_human(&value) {
            Ok(()) => EXIT_SUCCESS,
            Err(error) => {
                write_stderr(&error.to_string());
                error.exit_code()
            }
        },
        (OutputMode::Json, Err(error)) => {
            if let Err(write_error) = write_json_error(&error) {
                write_stderr(&write_error.to_string());
                write_stderr(&error.to_string());
                return write_error.exit_code();
            }
            error.exit_code()
        }
        (OutputMode::Human, Err(error)) => {
            write_stderr(&error.to_string());
            error.exit_code()
        }
    }
}
