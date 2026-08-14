//! `junban` binary — discovery, catalog tools, and ergonomic commands.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, error::ErrorKind};
use junban_cli::auth::{
    create_credential, emit_create, emit_list, emit_revoke, list_credentials, parse_expires_at,
    parse_scope, revoke_credential,
};
use junban_cli::commands::{data, plan, project, reminder, server, tag, task, tools};
use junban_cli::{
    CliError, OutputMode, TargetOptions, collect_status, emit_status, output, session::with_session,
};
use junban_server::AutomationScope;

#[derive(Debug, Parser)]
#[command(
    name = "junban",
    version,
    about = "Junban command-line client",
    disable_help_subcommand = true
)]
struct Args {
    /// Emit exactly one JSON value on stdout for success or failure.
    #[arg(long, global = true)]
    json: bool,
    /// Private profile directory (defaults to the same path as junban-server).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// Explicit server base URL. Requires a credential file; never uses the operator token.
    #[arg(long, global = true)]
    server: Option<String>,
    /// Private credential file for explicit --server targets (or JUNBAN_CREDENTIAL_FILE).
    #[arg(long, global = true)]
    credential_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Show owner connectivity status.
    Status,
    /// List the shared automation catalog.
    Tools {
        #[command(subcommand)]
        action: ToolsCommand,
    },
    /// Invoke one catalog tool by canonical name.
    Tool {
        #[command(subcommand)]
        action: ToolCommand,
    },
    /// Task operations.
    Task {
        #[command(subcommand)]
        action: TaskCommand,
    },
    /// Project operations.
    Project {
        #[command(subcommand)]
        action: ProjectCommand,
    },
    /// Tag operations.
    Tag {
        #[command(subcommand)]
        action: TagCommand,
    },
    /// Reminder operations.
    Reminder {
        #[command(subcommand)]
        action: ReminderCommand,
    },
    /// Planning and motivation reads.
    Plan {
        #[command(subcommand)]
        action: PlanCommand,
    },
    /// Import, export, backup, and restore.
    Data {
        #[command(subcommand)]
        action: DataCommand,
    },
    /// Manage scoped automation credentials (operator only).
    Auth {
        #[command(subcommand)]
        action: AuthCommand,
    },
    /// Operator server controls.
    Server {
        #[command(subcommand)]
        action: ServerCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ToolsCommand {
    /// List catalog tools (optionally filtered by scope).
    List {
        /// Filter: read, write, data, or operator.
        #[arg(long)]
        scope: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum ToolCommand {
    /// Call a catalog tool with JSON input.
    Call {
        /// Canonical catalog tool name (OpenAPI operation ID).
        name: String,
        /// JSON object, or @path to a JSON file.
        #[arg(long)]
        input: String,
        /// Optional download output path for data tools.
        #[arg(long)]
        output: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
enum TaskCommand {
    List {
        #[arg(long)]
        view: Option<String>,
        #[arg(long)]
        search: Option<String>,
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        project_id: Option<String>,
        #[arg(long)]
        tag_id: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
    Get {
        id: String,
    },
    Add {
        title: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        project_id: Option<String>,
        #[arg(long)]
        due_date: Option<String>,
        #[arg(long)]
        priority: Option<u8>,
    },
    Edit {
        id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        due_date: Option<String>,
        #[arg(long)]
        priority: Option<u8>,
    },
    Complete {
        id: String,
    },
    Uncomplete {
        id: String,
    },
    Cancel {
        id: String,
    },
    Reopen {
        id: String,
    },
    Delete {
        id: String,
        /// Required confirmation value: delete
        #[arg(long)]
        confirm: Option<String>,
    },
    Bulk {
        /// complete, uncomplete, cancel, reopen, or delete
        #[arg(long)]
        action: String,
        #[arg(long = "id", required = true)]
        ids: Vec<String>,
        #[arg(long)]
        confirm: Option<String>,
    },
    Undo {
        operation_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum ProjectCommand {
    List,
    Add {
        name: String,
        #[arg(long)]
        color: Option<String>,
    },
    Edit {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        color: Option<String>,
    },
    Archive {
        id: String,
    },
    Delete {
        id: String,
        #[arg(long)]
        confirm: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum TagCommand {
    List,
    Add {
        name: String,
        #[arg(long)]
        color: Option<String>,
    },
    Edit {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        color: Option<String>,
    },
    Delete {
        id: String,
        #[arg(long)]
        confirm: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum ReminderCommand {
    List {
        #[arg(long)]
        task_id: String,
    },
    Snooze {
        #[arg(long)]
        task_id: String,
        /// RFC 3339 instant with offset or Z.
        #[arg(long)]
        remind_at: String,
    },
    Dismiss {
        #[arg(long)]
        task_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum PlanCommand {
    Daily {
        #[arg(long)]
        date: Option<String>,
        #[arg(long)]
        capacity_minutes: Option<u32>,
    },
    #[command(name = "end-of-day")]
    EndOfDay {
        #[arg(long)]
        date: Option<String>,
        #[arg(long)]
        capacity_minutes: Option<u32>,
    },
    Weekly {
        #[arg(long)]
        date: Option<String>,
    },
    Calendar {
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        project_id: Option<String>,
    },
    Stats {
        #[arg(long)]
        from: String,
        #[arg(long)]
        to: String,
    },
    Nudges {
        #[arg(long)]
        date: Option<String>,
        #[arg(long)]
        capacity_minutes: Option<u32>,
    },
    #[command(name = "eat-the-frog")]
    EatTheFrog {
        #[arg(long)]
        date: Option<String>,
    },
    #[command(name = "task-jar")]
    TaskJar {
        #[arg(long)]
        date: Option<String>,
    },
    Dopamine {
        #[arg(long)]
        date: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum DataCommand {
    Export {
        #[arg(long)]
        format: String,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = false)]
        overwrite: bool,
    },
    #[command(name = "import-preview")]
    ImportPreview {
        #[arg(long)]
        format: String,
        #[arg(long)]
        file: PathBuf,
    },
    Import {
        #[arg(long)]
        format: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        fingerprint: String,
    },
    Backup {
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = false)]
        overwrite: bool,
    },
    Restore {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        confirm: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    Create {
        #[arg(long = "name")]
        name: String,
        #[arg(long = "scope", value_parser = parse_scope)]
        scopes: Vec<AutomationScope>,
        #[arg(long = "write-token")]
        write_token: PathBuf,
        #[arg(long = "expires-at", value_parser = parse_expires_at)]
        expires_at: Option<jiff::Timestamp>,
    },
    List,
    Revoke {
        id: String,
        #[arg(long)]
        confirm: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum ServerCommand {
    Hosts {
        #[command(subcommand)]
        action: HostsCommand,
    },
    #[command(name = "rotate-token")]
    RotateToken {
        #[arg(long = "write-token")]
        write_token: PathBuf,
        #[arg(long)]
        confirm: Option<String>,
    },
    Diagnostics {
        #[command(subcommand)]
        action: DiagnosticsCommand,
    },
    Maintenance,
    Recovery {
        #[command(subcommand)]
        action: RecoveryCommand,
    },
}

#[derive(Debug, Subcommand)]
enum HostsCommand {
    Get,
    Set {
        #[arg(long = "host", required = true)]
        hosts: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum DiagnosticsCommand {
    Get,
    Clear {
        #[arg(long)]
        confirm: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum RecoveryCommand {
    Status,
}

fn confirm_is(value: &Option<String>, expected: &str) -> bool {
    value.as_deref() == Some(expected)
}

#[tokio::main]
async fn main() -> ExitCode {
    let raw: Vec<_> = std::env::args_os().collect();
    let json_intent = raw.iter().skip(1).any(|arg| arg == OsStr::new("--json"));
    let args = match Args::try_parse_from(&raw) {
        Ok(args) => args,
        Err(_error) if json_intent => {
            let parse_error = CliError::usage(
                "argument_parse_failed",
                "command-line arguments are invalid; use --help for supported syntax",
            );
            if let Err(write_error) = output::write_json_error(&parse_error) {
                output::write_stderr(&write_error.to_string());
                return exit_code(write_error.exit_code());
            }
            return exit_code(parse_error.exit_code());
        }
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            let _ = error.print();
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            let code = error.exit_code();
            let _ = error.print();
            return exit_code(code);
        }
    };
    let mode = if args.json {
        OutputMode::Json
    } else {
        OutputMode::Human
    };
    exit_code(run(mode, args).await)
}

fn exit_code(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

async fn run(mode: OutputMode, args: Args) -> i32 {
    let result = async {
        let options = TargetOptions::with_defaults(
            args.data_dir.clone(),
            args.server.clone(),
            args.credential_file.clone(),
        );
        let profile_dir = options.profile_dir.clone();
        match args.command {
            Command::Status => {
                let report = with_session(options, async |session| {
                    collect_status(session, &profile_dir).await
                })
                .await?;
                emit_status(mode, &report)?;
            }
            Command::Tools {
                action: ToolsCommand::List { scope },
            } => {
                tools::tools_list(mode, scope.as_deref()).await?;
            }
            Command::Tool {
                action:
                    ToolCommand::Call {
                        name,
                        input,
                        output,
                    },
            } => {
                with_session(options, async move |session| {
                    tools::tool_call(
                        session,
                        mode,
                        &name,
                        &input,
                        output.as_ref().map(|path| path.to_str().unwrap_or("")),
                    )
                    .await
                })
                .await?;
            }
            Command::Task { action } => {
                with_session(options, async move |session| match action {
                    TaskCommand::List {
                        view,
                        search,
                        status,
                        project_id,
                        tag_id,
                        limit,
                    } => {
                        task::list(
                            session, mode, view, search, status, project_id, tag_id, limit,
                        )
                        .await
                    }
                    TaskCommand::Get { id } => task::get(session, mode, &id).await,
                    TaskCommand::Add {
                        title,
                        description,
                        project_id,
                        due_date,
                        priority,
                    } => {
                        task::add(
                            session,
                            mode,
                            title,
                            description,
                            project_id,
                            due_date,
                            priority,
                        )
                        .await
                    }
                    TaskCommand::Edit {
                        id,
                        title,
                        description,
                        due_date,
                        priority,
                    } => {
                        task::edit(session, mode, &id, title, description, due_date, priority).await
                    }
                    TaskCommand::Complete { id } => {
                        task::status_action(session, mode, "complete_task", &id).await
                    }
                    TaskCommand::Uncomplete { id } => {
                        task::status_action(session, mode, "uncomplete_task", &id).await
                    }
                    TaskCommand::Cancel { id } => {
                        task::status_action(session, mode, "cancel_task", &id).await
                    }
                    TaskCommand::Reopen { id } => {
                        task::status_action(session, mode, "reopen_task", &id).await
                    }
                    TaskCommand::Delete { id, confirm } => {
                        task::delete(session, mode, &id, confirm_is(&confirm, "delete")).await
                    }
                    TaskCommand::Bulk {
                        action,
                        ids,
                        confirm,
                    } => {
                        task::bulk(session, mode, action, ids, confirm_is(&confirm, "delete")).await
                    }
                    TaskCommand::Undo { operation_id } => {
                        task::undo(session, mode, &operation_id).await
                    }
                })
                .await?;
            }
            Command::Project { action } => {
                with_session(options, async move |session| match action {
                    ProjectCommand::List => project::list(session, mode).await,
                    ProjectCommand::Add { name, color } => {
                        project::add(session, mode, name, color).await
                    }
                    ProjectCommand::Edit { id, name, color } => {
                        project::edit(session, mode, &id, name, color, None).await
                    }
                    ProjectCommand::Archive { id } => {
                        project::archive(session, mode, &id, true).await
                    }
                    ProjectCommand::Delete { id, confirm } => {
                        project::delete(session, mode, &id, confirm_is(&confirm, "delete")).await
                    }
                })
                .await?;
            }
            Command::Tag { action } => {
                with_session(options, async move |session| match action {
                    TagCommand::List => tag::list(session, mode).await,
                    TagCommand::Add { name, color } => tag::add(session, mode, name, color).await,
                    TagCommand::Edit { id, name, color } => {
                        tag::edit(session, mode, &id, name, color).await
                    }
                    TagCommand::Delete { id, confirm } => {
                        tag::delete(session, mode, &id, confirm_is(&confirm, "delete")).await
                    }
                })
                .await?;
            }
            Command::Reminder { action } => {
                with_session(options, async move |session| match action {
                    ReminderCommand::List { task_id } => {
                        reminder::list(session, mode, &task_id).await
                    }
                    ReminderCommand::Snooze { task_id, remind_at } => {
                        reminder::snooze(session, mode, &task_id, &remind_at).await
                    }
                    ReminderCommand::Dismiss { task_id } => {
                        reminder::dismiss(session, mode, &task_id).await
                    }
                })
                .await?;
            }
            Command::Plan { action } => {
                with_session(options, async move |session| match action {
                    PlanCommand::Daily {
                        date,
                        capacity_minutes,
                    } => plan::daily(session, mode, date, capacity_minutes).await,
                    PlanCommand::EndOfDay {
                        date,
                        capacity_minutes,
                    } => plan::end_of_day(session, mode, date, capacity_minutes).await,
                    PlanCommand::Weekly { date } => plan::weekly(session, mode, date).await,
                    PlanCommand::Calendar {
                        from,
                        to,
                        project_id,
                    } => plan::calendar(session, mode, from, to, project_id).await,
                    PlanCommand::Stats { from, to } => plan::stats(session, mode, from, to).await,
                    PlanCommand::Nudges {
                        date,
                        capacity_minutes,
                    } => plan::nudges(session, mode, date, capacity_minutes).await,
                    PlanCommand::EatTheFrog { date } => {
                        plan::eat_the_frog(session, mode, date).await
                    }
                    PlanCommand::TaskJar { date } => plan::task_jar(session, mode, date).await,
                    PlanCommand::Dopamine { date } => plan::dopamine(session, mode, date).await,
                })
                .await?;
            }
            Command::Data { action } => {
                with_session(options, async move |session| match action {
                    DataCommand::Export {
                        format,
                        output,
                        overwrite,
                    } => data::export(session, mode, format, output, overwrite).await,
                    DataCommand::ImportPreview { format, file } => {
                        data::import_preview(session, mode, format, file).await
                    }
                    DataCommand::Import {
                        format,
                        file,
                        fingerprint,
                    } => data::import_apply(session, mode, format, file, fingerprint).await,
                    DataCommand::Backup { output, overwrite } => {
                        data::backup(session, mode, output, overwrite).await
                    }
                    DataCommand::Restore { input, confirm } => {
                        data::restore(session, mode, input, confirm_is(&confirm, "restore")).await
                    }
                })
                .await?;
            }
            Command::Auth { action } => match action {
                AuthCommand::Create {
                    name,
                    scopes,
                    write_token,
                    expires_at,
                } => {
                    let report = with_session(options, async move |session| {
                        create_credential(session, &name, &scopes, &write_token, expires_at).await
                    })
                    .await?;
                    emit_create(mode, &report)?;
                }
                AuthCommand::List => {
                    let credentials =
                        with_session(options, async |session| list_credentials(session).await)
                            .await?;
                    emit_list(mode, &credentials)?;
                }
                AuthCommand::Revoke { id, confirm } => {
                    if !confirm_is(&confirm, "revoke") {
                        return Err(CliError::usage(
                            "confirmation_required",
                            "destructive operation requires --confirm revoke",
                        ));
                    }
                    with_session(options, async |session| {
                        revoke_credential(session, &id).await
                    })
                    .await?;
                    emit_revoke(mode, &id)?;
                }
            },
            Command::Server { action } => {
                with_session(options, async move |session| match action {
                    ServerCommand::Hosts { action } => match action {
                        HostsCommand::Get => server::hosts_get(session, mode).await,
                        HostsCommand::Set { hosts } => {
                            server::hosts_set(session, mode, hosts).await
                        }
                    },
                    ServerCommand::RotateToken {
                        write_token,
                        confirm,
                    } => {
                        server::rotate_token(
                            session,
                            mode,
                            write_token,
                            confirm_is(&confirm, "rotate-token"),
                        )
                        .await
                    }
                    ServerCommand::Diagnostics { action } => match action {
                        DiagnosticsCommand::Get => server::diagnostics_get(session, mode).await,
                        DiagnosticsCommand::Clear { confirm } => {
                            server::diagnostics_clear(session, mode, confirm_is(&confirm, "clear"))
                                .await
                        }
                    },
                    ServerCommand::Maintenance => server::maintenance(session, mode).await,
                    ServerCommand::Recovery {
                        action: RecoveryCommand::Status,
                    } => server::recovery_status(session, mode).await,
                })
                .await?;
            }
        }
        Ok::<(), CliError>(())
    }
    .await;

    match (mode, result) {
        (_, Ok(())) => junban_cli::error::EXIT_SUCCESS,
        (OutputMode::Json, Err(error)) => {
            if let Err(write_error) = output::write_json_error(&error) {
                output::write_stderr(&write_error.to_string());
                output::write_stderr(&error.to_string());
                return write_error.exit_code();
            }
            error.exit_code()
        }
        (OutputMode::Human, Err(error)) => {
            output::write_stderr(&error.to_string());
            error.exit_code()
        }
    }
}
