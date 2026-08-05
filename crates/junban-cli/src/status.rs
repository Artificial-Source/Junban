//! `junban status` command.

use serde::Serialize;

use crate::discovery::HealthPayload;
use crate::error::CliError;
use crate::output::{self, OutputMode};
use crate::session::{Session, SessionMode};

/// Stable status document for human and JSON output.
#[derive(Debug, Clone, Serialize)]
pub struct StatusReport {
    pub status: String,
    pub mode: SessionMode,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub profile_dir: String,
}

/// Collect status through the shared session (health only in Wave 0).
///
/// Uses a mutable session so discovered local handoff can replace ownership after a
/// definitive connect failure. Reported mode/address/instance always reflect the
/// session after any reconnect (the replacement owner), never the stale discovery target.
pub async fn collect_status(
    session: &mut Session,
    profile_dir: &std::path::Path,
) -> Result<StatusReport, CliError> {
    let health: HealthPayload = session.get_json_public("/api/v1/health").await?;
    let address = session
        .base_url()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_owned();
    let instance_id = session
        .instance_id()
        .map(str::to_owned)
        .or_else(|| Some(health.instance_id.clone()));
    Ok(StatusReport {
        status: health.status,
        mode: session.mode(),
        address,
        instance_id,
        profile_dir: profile_dir.display().to_string(),
    })
}

/// Render and emit status for the selected output mode.
pub fn emit_status(mode: OutputMode, report: &StatusReport) -> Result<(), CliError> {
    match mode {
        OutputMode::Json => output::write_json_success(report),
        OutputMode::Human => {
            output::write_human_line(&format!("status: {}", report.status))?;
            output::write_human_line(&format!("mode: {}", report.mode))?;
            output::write_human_line(&format!("address: {}", report.address))?;
            if let Some(instance_id) = &report.instance_id {
                output::write_human_line(&format!("instance_id: {instance_id}"))?;
            }
            output::write_human_line(&format!("profile: {}", report.profile_dir))?;
            Ok(())
        }
    }
}

/// Friendlier human mode labels.
impl std::fmt::Display for SessionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Discovered => write!(f, "discovered"),
            Self::TemporaryOwner => write!(f, "temporary-owner"),
            Self::Explicit => write!(f, "explicit"),
        }
    }
}
