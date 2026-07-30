//! Development-only Phase 2 scale fixture seeder.
//!
//! Build: `cargo build -p junban-storage --features scale-bench --bin junban-scale-seed`
//! Never linked into `junban-server` release artifacts.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use junban_storage::scale_seed::{SeedConfig, host_as_of_date, seed_phase2_scale};

fn print_usage() {
    eprintln!(
        "Usage: junban-scale-seed --data-dir <path> [--task-count <n>] [--as-of-date YYYY-MM-DD]\n\
         \n\
         Development-only Phase 2 scale fixture. Writes junban.sqlite3 and\n\
         scale-seed-manifest.json under --data-dir. Not part of release artifacts."
    );
}

fn main() -> ExitCode {
    let mut data_dir: Option<PathBuf> = None;
    let mut task_count: u32 = 10_000;
    let mut as_of_raw: Option<String> = None;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print_usage();
                return ExitCode::SUCCESS;
            }
            "--data-dir" => {
                let Some(value) = args.next() else {
                    eprintln!("missing value for --data-dir");
                    print_usage();
                    return ExitCode::from(2);
                };
                data_dir = Some(PathBuf::from(value));
            }
            "--task-count" => {
                let Some(value) = args.next() else {
                    eprintln!("missing value for --task-count");
                    return ExitCode::from(2);
                };
                match value.parse::<u32>() {
                    Ok(n) => task_count = n,
                    Err(_) => {
                        eprintln!("invalid --task-count: {value}");
                        return ExitCode::from(2);
                    }
                }
            }
            "--as-of-date" => {
                let Some(value) = args.next() else {
                    eprintln!("missing value for --as-of-date");
                    return ExitCode::from(2);
                };
                as_of_raw = Some(value);
            }
            other => {
                eprintln!("unknown argument: {other}");
                print_usage();
                return ExitCode::from(2);
            }
        }
    }

    let Some(data_dir) = data_dir else {
        eprintln!("--data-dir is required");
        print_usage();
        return ExitCode::from(2);
    };

    let as_of = match as_of_raw {
        Some(raw) => match raw.parse() {
            Ok(date) => date,
            Err(_) => {
                eprintln!("invalid --as-of-date (expected YYYY-MM-DD): {raw}");
                return ExitCode::from(2);
            }
        },
        None => match host_as_of_date() {
            Ok(date) => date,
            Err(error) => {
                eprintln!("could not resolve host date: {error}");
                return ExitCode::from(1);
            }
        },
    };

    let config = match SeedConfig::new(task_count, as_of) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("invalid seed configuration: {error}");
            return ExitCode::from(2);
        }
    };

    match seed_phase2_scale(&data_dir, &config) {
        Ok(manifest) => {
            println!(
                "seeded {} tasks into {} in {:.1}ms",
                manifest.task_count,
                data_dir.display(),
                manifest.seed_duration_ms
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("seed failed: {error}");
            ExitCode::from(1)
        }
    }
}
