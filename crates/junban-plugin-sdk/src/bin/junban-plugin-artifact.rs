#![forbid(unsafe_code)]

use std::{path::PathBuf, process::ExitCode};

use clap::{Args, Parser, Subcommand};
use junban_plugin_sdk::artifact::{
    check_source_manifest, publish_signing_public_key, sign_package_artifact, sign_registry_index,
    verify_package_artifact, verify_registry_references, write_registry_include_table,
};

#[derive(Parser)]
#[command(
    name = "junban-plugin-artifact",
    about = "Deterministic Junban plugin artifact construction and verification",
    long_about = "Deterministic Junban plugin artifact construction and verification.\n\nSigning keys are accepted only through --key-file. The file must contain exactly 32 raw bytes forming an Ed25519 seed and must satisfy strict external owner-private path and metadata checks. Key bytes are never accepted through arguments or environment variables. Public-key derivation writes exactly 32 raw Ed25519 verifying-key bytes to a new output file. Windows signing currently fails closed because this first-stage tool cannot prove an owner-only DACL without an additional reviewed platform implementation."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Validate one author source manifest.
    SourceManifest {
        #[command(subcommand)]
        command: SourceManifestCommand,
    },
    /// Derive public material from one externally held signing seed.
    Key {
        #[command(subcommand)]
        command: KeyCommand,
    },
    /// Construct or publicly verify one JBP1 package.
    Package {
        #[command(subcommand)]
        command: PackageCommand,
    },
    /// Construct and sign one package-derived JRI1 index.
    Index {
        #[command(subcommand)]
        command: IndexCommand,
    },
    /// Generate or publicly verify the complete bundled registry authority.
    Registry {
        #[command(subcommand)]
        command: RegistryCommand,
    },
}

#[derive(Subcommand)]
enum SourceManifestCommand {
    /// Parse and validate a source manifest without deriving package identities.
    Check { source: PathBuf },
}

#[derive(Subcommand)]
enum KeyCommand {
    /// Derive and publish one exact raw 32-byte Ed25519 public key.
    Public(PublicKeyArgs),
}

#[derive(Subcommand)]
enum PackageCommand {
    /// Inspect a component, derive its runtime manifest, sign JBP1, and verify it.
    Sign(SignArgs),
    /// Publicly verify JBP1 against exact source and component inputs.
    Verify(VerifyArgs),
}

#[derive(Subcommand)]
enum IndexCommand {
    /// Build a package-derived typed index, sign it, and publish its public root.
    Sign(IndexSignArgs),
}

#[derive(Subcommand)]
enum RegistryCommand {
    /// Generate the verified package include module, or exact-check it.
    IncludeTable(IncludeTableArgs),
    /// Publicly verify registry, packages, references, WIT, and include module.
    Verify(RegistryVerifyArgs),
}

#[derive(Args)]
struct PublicKeyArgs {
    /// Raw exact 32-byte Ed25519 seed file; seed bytes are never accepted as arguments or environment values.
    #[arg(long, value_name = "EXTERNAL_OWNER_PRIVATE_SEED_FILE")]
    key_file: PathBuf,
    /// New raw exact 32-byte Ed25519 public key file. Existing files are never overwritten.
    #[arg(long, value_name = "NEW_32_BYTE_PUBLIC_KEY_FILE")]
    output: PathBuf,
}

#[derive(Args)]
struct SignArgs {
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    component: PathBuf,
    /// Raw exact 32-byte Ed25519 seed file; seed bytes are never accepted as arguments or environment values.
    #[arg(long, value_name = "EXTERNAL_OWNER_PRIVATE_SEED_FILE")]
    key_file: PathBuf,
    /// New JBP1 path. Existing files are never overwritten.
    #[arg(long)]
    output: PathBuf,
}

#[derive(Args)]
struct VerifyArgs {
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    component: PathBuf,
    #[arg(long)]
    package: PathBuf,
}

#[derive(Args)]
struct IndexSignArgs {
    #[arg(long)]
    packages: PathBuf,
    #[arg(long)]
    metadata: PathBuf,
    /// Exact raw 32-byte publisher public key required for every staged JBP1.
    #[arg(long)]
    publisher_public_key: PathBuf,
    /// Raw exact 32-byte Ed25519 seed file; seed bytes are never accepted as arguments or environment values.
    #[arg(long, value_name = "EXTERNAL_OWNER_PRIVATE_SEED_FILE")]
    key_file: PathBuf,
    /// New exact 32-byte public key path. Existing files are never overwritten.
    #[arg(long)]
    root_public_key_output: PathBuf,
    /// New JRI1 path. Existing files are never overwritten.
    #[arg(long)]
    output: PathBuf,
}

#[derive(Args)]
struct IncludeTableArgs {
    #[arg(long)]
    root_public_key: PathBuf,
    /// Exact raw 32-byte publisher public key required for every JBP1.
    #[arg(long)]
    publisher_public_key: PathBuf,
    #[arg(long)]
    index: PathBuf,
    #[arg(long)]
    packages: PathBuf,
    #[arg(long)]
    output: PathBuf,
    /// Exact-compare the existing output instead of writing.
    #[arg(long)]
    check: bool,
}

#[derive(Args)]
struct RegistryVerifyArgs {
    #[arg(long)]
    references: PathBuf,
    /// Exact author-controlled source metadata used to construct the signed index.
    #[arg(long)]
    metadata: PathBuf,
    #[arg(long)]
    root_public_key: PathBuf,
    /// Exact raw 32-byte publisher public key required for every JBP1.
    #[arg(long)]
    publisher_public_key: PathBuf,
    #[arg(long)]
    index: PathBuf,
    #[arg(long)]
    packages: PathBuf,
    #[arg(long)]
    include_table: PathBuf,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(message) => {
            println!("{message}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<&'static str, junban_plugin_sdk::artifact::ArtifactError> {
    match cli.command {
        Command::SourceManifest {
            command: SourceManifestCommand::Check { source },
        } => {
            check_source_manifest(&source)?;
            Ok("source manifest is valid")
        }
        Command::Key {
            command: KeyCommand::Public(args),
        } => {
            publish_signing_public_key(&args.key_file, &args.output)?;
            Ok("publisher public key was derived and published")
        }
        Command::Package {
            command: PackageCommand::Sign(args),
        } => {
            sign_package_artifact(&args.source, &args.component, &args.key_file, &args.output)?;
            Ok("package was signed and publicly verified")
        }
        Command::Package {
            command: PackageCommand::Verify(args),
        } => {
            verify_package_artifact(&args.source, &args.component, &args.package)?;
            Ok("package is valid and matches its source and component")
        }
        Command::Index {
            command: IndexCommand::Sign(args),
        } => {
            sign_registry_index(
                &args.packages,
                &args.metadata,
                &args.publisher_public_key,
                &args.key_file,
                &args.root_public_key_output,
                &args.output,
            )?;
            Ok("registry index was signed and publicly verified")
        }
        Command::Registry {
            command: RegistryCommand::IncludeTable(args),
        } => {
            write_registry_include_table(
                &args.root_public_key,
                &args.publisher_public_key,
                &args.index,
                &args.packages,
                &args.output,
                args.check,
            )?;
            Ok(if args.check {
                "registry include table is current"
            } else {
                "registry include table was generated"
            })
        }
        Command::Registry {
            command: RegistryCommand::Verify(args),
        } => {
            verify_registry_references(
                &args.references,
                &args.metadata,
                &args.root_public_key,
                &args.publisher_public_key,
                &args.index,
                &args.packages,
                &args.include_table,
            )?;
            Ok("registry, packages, references, and include table are valid")
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;

    #[test]
    fn stable_commands_and_raw_seed_help_are_present() {
        let help = Cli::command().render_long_help().to_string();
        assert!(help.contains("source-manifest"));
        assert!(help.contains("key"));
        assert!(help.contains("package"));
        assert!(help.contains("index"));
        assert!(help.contains("registry"));
        assert!(help.contains("exactly 32 raw bytes"));
        assert!(help.contains("exactly 32 raw Ed25519 verifying-key bytes"));
        assert!(help.contains("fails closed"));

        let mut command = Cli::command();
        let public_help = command
            .find_subcommand_mut("key")
            .unwrap()
            .find_subcommand_mut("public")
            .unwrap()
            .render_long_help()
            .to_string();
        assert!(public_help.contains("Raw exact 32-byte Ed25519 seed file"));
        assert!(public_help.contains("New raw exact 32-byte Ed25519 public key file"));
        assert!(public_help.contains("EXTERNAL_OWNER_PRIVATE_SEED_FILE"));
        assert!(public_help.contains("NEW_32_BYTE_PUBLIC_KEY_FILE"));

        assert!(Cli::try_parse_from(["tool", "source-manifest", "check", "source.json"]).is_ok());
        assert!(
            Cli::try_parse_from([
                "tool",
                "key",
                "public",
                "--key-file",
                "publisher.seed",
                "--output",
                "publisher.bin",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "tool",
                "package",
                "sign",
                "--source",
                "source.json",
                "--component",
                "component.wasm",
                "--key-file",
                "publisher.seed",
                "--output",
                "package.jbp",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "tool",
                "package",
                "verify",
                "--source",
                "source.json",
                "--component",
                "component.wasm",
                "--package",
                "package.jbp",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "tool",
                "index",
                "sign",
                "--packages",
                "sha256",
                "--metadata",
                "registry-source.json",
                "--publisher-public-key",
                "publisher.bin",
                "--key-file",
                "root.seed",
                "--root-public-key-output",
                "root.bin",
                "--output",
                "index.jri",
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "tool",
                "registry",
                "include-table",
                "--root-public-key",
                "root.bin",
                "--publisher-public-key",
                "publisher.bin",
                "--index",
                "index.jri",
                "--packages",
                "sha256",
                "--output",
                "include.rs",
                "--check",
            ])
            .is_ok()
        );
        let mut command = Cli::command();
        let registry_verify_help = command
            .find_subcommand_mut("registry")
            .unwrap()
            .find_subcommand_mut("verify")
            .unwrap()
            .render_long_help()
            .to_string();
        assert!(registry_verify_help.contains("--metadata <METADATA>"));
        assert!(registry_verify_help.contains("author-controlled source metadata"));

        let registry_verify_args = [
            "tool",
            "registry",
            "verify",
            "--references",
            "references",
            "--metadata",
            "registry-source.json",
            "--root-public-key",
            "root.bin",
            "--publisher-public-key",
            "publisher.bin",
            "--index",
            "index.jri",
            "--packages",
            "sha256",
            "--include-table",
            "include.rs",
        ];
        assert!(Cli::try_parse_from(registry_verify_args).is_ok());
        assert!(
            Cli::try_parse_from(
                registry_verify_args
                    .into_iter()
                    .filter(|arg| { *arg != "--metadata" && *arg != "registry-source.json" })
            )
            .is_err()
        );
    }
}
