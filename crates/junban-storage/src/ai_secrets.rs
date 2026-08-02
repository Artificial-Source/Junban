//! Private versioned AI/provider secret file authority.
//!
//! Raw secret bytes live only in `ai-secrets.json` beside other profile security
//! artifacts. They never enter SQLite, settings snapshots, events, receipts,
//! Debug output, errors, or tests.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs, io,
    path::{Path, PathBuf},
    sync::RwLock,
};

use hmac::{Hmac, Mac};
use jiff::Timestamp;
use junban_app::AiSecretBytes;
use junban_domain::{
    AI_SECRETS_FILE, AI_SECRETS_FILE_VERSION, AI_SECRETS_MAX, AiCredentialId, AiSecretKind,
    AiSecretMetadata,
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::atomic_replace_private_file;

const VERIFICATION_KEY_BYTES: usize = 32;
const VERIFICATION_KEY_HEX_BYTES: usize = VERIFICATION_KEY_BYTES * 2;
const RECEIPT_VERIFIER_DOMAIN: &[u8] = b"junban-ai-secret-receipt-v1\0";

/// Internal durable record. The `secret` field is never re-exported.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredAiSecret {
    id: String,
    kind: AiSecretKind,
    updated_at: Timestamp,
    secret: String,
}

impl fmt::Debug for StoredAiSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredAiSecret")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("updated_at", &self.updated_at)
            .field("secret", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AiSecretsFile {
    version: u32,
    verification_key: String,
    secrets: Vec<StoredAiSecret>,
}

/// In-memory authority loaded from the durable private secrets file.
pub struct AiSecretStore {
    path: PathBuf,
    /// Stable profile-private HMAC key. `None` only when the file does not exist.
    verification_key: Option<String>,
    /// Confirmed file contents. In-memory reads follow this map only.
    secrets: RwLock<BTreeMap<String, StoredAiSecret>>,
}

impl fmt::Debug for AiSecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let count = self
            .secrets
            .read()
            .map(|guard| guard.len())
            .unwrap_or_default();
        f.debug_struct("AiSecretStore")
            .field("path", &self.path)
            .field("count", &count)
            .finish()
    }
}

impl AiSecretStore {
    /// Load secrets from the profile directory. Missing file yields an empty set
    /// without creating an artifact. Malformed content, unknown versions/fields/kinds,
    /// duplicates, invalid verification keys, and oversize fail closed.
    pub fn load(profile_dir: &Path) -> io::Result<Self> {
        let path = profile_dir.join(AI_SECRETS_FILE);
        let (verification_key, secrets) = match fs::read(&path) {
            Ok(data) => {
                let (key, secrets) = parse_secrets_document(&data).map_err(io::Error::other)?;
                (Some(key), secrets)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (None, BTreeMap::new()),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            verification_key,
            secrets: RwLock::new(secrets),
        })
    }

    /// Load the strict private authority, durably creating its random verifier key
    /// when absent. Publication receipts may only be built from this constructor.
    pub(crate) fn load_or_create(profile_dir: &Path) -> io::Result<Self> {
        let mut store = Self::load(profile_dir)?;
        if store.verification_key.is_none() {
            let mut random = [0_u8; VERIFICATION_KEY_BYTES];
            getrandom::fill(&mut random).map_err(|error| {
                io::Error::other(format!("random key generation failed: {error}"))
            })?;
            let verification_key = hex_encode(&random);
            let secrets = store.secrets.read().expect("ai secrets poisoned");
            persist_secrets(&store.path, &verification_key, &secrets)?;
            drop(secrets);
            store.verification_key = Some(verification_key);
        }
        Ok(store)
    }

    /// Compute the keyed, domain-separated receipt verifier for secret request bytes.
    pub(crate) fn receipt_verifier(
        &self,
        secret: &AiSecretBytes,
    ) -> Result<String, AiSecretStoreError> {
        let key = self
            .verification_key
            .as_deref()
            .ok_or(AiSecretStoreError::Invalid(
                "verification key is unavailable",
            ))?;
        let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes())
            .map_err(|_| AiSecretStoreError::Invalid("verification key is invalid"))?;
        mac.update(RECEIPT_VERIFIER_DOMAIN);
        mac.update(secret.expose().as_bytes());
        Ok(hex_encode(&mac.finalize().into_bytes()))
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Presence-only metadata for every stored secret (sorted by id).
    #[must_use]
    pub fn list_metadata(&self) -> Vec<AiSecretMetadata> {
        self.secrets
            .read()
            .expect("ai secrets poisoned")
            .values()
            .map(|stored| AiSecretMetadata {
                id: AiCredentialId::parse(&stored.id).expect("stored id is valid"),
                kind: stored.kind,
                updated_at: stored.updated_at,
                present: true,
            })
            .collect()
    }

    /// Resolve raw bytes only when the confirmed binding ID is present.
    ///
    /// Reconstruction always re-admits through [`AiSecretBytes::new`]. Corrupted
    /// durable material fails closed without leaking bytes into the error path.
    pub fn get_secret(
        &self,
        id: &AiCredentialId,
    ) -> Result<Option<AiSecretBytes>, AiSecretStoreError> {
        let guard = self.secrets.read().expect("ai secrets poisoned");
        let Some(stored) = guard.get(&id.to_string()) else {
            return Ok(None);
        };
        Ok(Some(admit_secret_bytes(stored.secret.clone())?))
    }

    /// Atomically publish a new unreferenced secret and return its stable ID.
    ///
    /// Does not modify settings. A failed publication leaves the prior file intact.
    /// Defense-in-depth: revalidates material immediately before durable replace.
    pub fn publish(
        &self,
        kind: AiSecretKind,
        secret: AiSecretBytes,
        now: Timestamp,
    ) -> Result<AiCredentialId, AiSecretStoreError> {
        // Re-admit so no unchecked path can persist empty/oversized/control material.
        let secret = admit_secret_bytes(secret.expose().to_owned())?;
        let id = AiCredentialId::new();
        let record = StoredAiSecret {
            id: id.to_string(),
            kind,
            updated_at: now,
            secret: secret.expose().to_owned(),
        };
        let mut guard = self.secrets.write().expect("ai secrets poisoned");
        if guard.len() >= AI_SECRETS_MAX {
            return Err(AiSecretStoreError::BoundExceeded);
        }
        if guard.contains_key(&record.id) {
            return Err(AiSecretStoreError::Conflict);
        }
        let mut next = guard.clone();
        next.insert(record.id.clone(), record);
        let verification_key =
            self.verification_key
                .as_deref()
                .ok_or(AiSecretStoreError::Invalid(
                    "verification key is unavailable",
                ))?;
        persist_secrets(&self.path, verification_key, &next)?;
        *guard = next;
        Ok(id)
    }

    /// Idempotent delete by id. Missing ids succeed. Persist first, then memory.
    pub fn delete(&self, id: &AiCredentialId) -> Result<(), AiSecretStoreError> {
        self.delete_with(id, persist_secrets)
    }

    fn delete_with(
        &self,
        id: &AiCredentialId,
        persist: impl FnOnce(&Path, &str, &BTreeMap<String, StoredAiSecret>) -> io::Result<()>,
    ) -> Result<(), AiSecretStoreError> {
        let key = id.to_string();
        let mut guard = self.secrets.write().expect("ai secrets poisoned");
        if !guard.contains_key(&key) {
            return Ok(());
        }
        let mut next = guard.clone();
        next.remove(&key);
        let verification_key =
            self.verification_key
                .as_deref()
                .ok_or(AiSecretStoreError::Invalid(
                    "verification key is unavailable",
                ))?;
        persist(&self.path, verification_key, &next)?;
        *guard = next;
        Ok(())
    }

    /// Remove every secret ID not present in `referenced`. Never invents bindings.
    ///
    /// Cleanup failure is returned to the caller; settings remain authoritative.
    pub fn reconcile_unreferenced(
        &self,
        referenced: &[AiCredentialId],
    ) -> Result<usize, AiSecretStoreError> {
        let referenced: BTreeSet<String> = referenced.iter().map(ToString::to_string).collect();
        let mut guard = self.secrets.write().expect("ai secrets poisoned");
        let stale: Vec<String> = guard
            .keys()
            .filter(|id| !referenced.contains(id.as_str()))
            .cloned()
            .collect();
        if stale.is_empty() {
            return Ok(0);
        }
        let mut next = guard.clone();
        for id in &stale {
            next.remove(id);
        }
        let verification_key =
            self.verification_key
                .as_deref()
                .ok_or(AiSecretStoreError::Invalid(
                    "verification key is unavailable",
                ))?;
        persist_secrets(&self.path, verification_key, &next)?;
        let removed = stale.len();
        *guard = next;
        Ok(removed)
    }

    /// Test helper: in-memory entry count.
    #[cfg(test)]
    #[must_use]
    pub fn len_for_test(&self) -> usize {
        self.secrets.read().expect("ai secrets poisoned").len()
    }

    /// Test helper: inject persist failure on delete.
    #[cfg(test)]
    #[allow(private_bounds)]
    pub(crate) fn delete_with_persist_for_test(
        &self,
        id: &AiCredentialId,
        persist: impl FnOnce(&Path, &str, &BTreeMap<String, StoredAiSecret>) -> io::Result<()>,
    ) -> Result<(), AiSecretStoreError> {
        self.delete_with(id, persist)
    }
}

/// Secret-store mutation and decode failures. Messages never include secret bytes.
#[derive(Debug)]
pub enum AiSecretStoreError {
    Conflict,
    BoundExceeded,
    Invalid(&'static str),
    Io(io::Error),
}

impl From<io::Error> for AiSecretStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl fmt::Display for AiSecretStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => write!(f, "ai secret id already exists"),
            Self::BoundExceeded => {
                write!(f, "at most {AI_SECRETS_MAX} ai secrets are allowed")
            }
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for AiSecretStoreError {}

/// Re-admit durable or in-flight secret material through the public validator.
/// Error messages never include secret bytes.
fn admit_secret_bytes(value: String) -> Result<AiSecretBytes, AiSecretStoreError> {
    AiSecretBytes::new(value).map_err(|error| match error {
        junban_domain::ValidationError::Empty { .. } => {
            AiSecretStoreError::Invalid("ai secret value must not be empty")
        }
        junban_domain::ValidationError::TooLong { .. } => {
            AiSecretStoreError::Invalid("ai secret value exceeds the 8 KiB ceiling")
        }
        junban_domain::ValidationError::Invalid { .. } => {
            AiSecretStoreError::Invalid("ai secret value must not contain control characters")
        }
        _ => AiSecretStoreError::Invalid("ai secret value is invalid"),
    })
}

fn parse_secrets_document(
    data: &[u8],
) -> Result<(String, BTreeMap<String, StoredAiSecret>), String> {
    let document: AiSecretsFile = serde_json::from_slice(data)
        .map_err(|error| format!("invalid ai-secrets.json: {error}"))?;
    if document.version != AI_SECRETS_FILE_VERSION {
        return Err(format!(
            "unsupported ai-secrets.json version {}",
            document.version
        ));
    }
    if document.verification_key.len() != VERIFICATION_KEY_HEX_BYTES
        || !document
            .verification_key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("ai-secrets.json verification key is invalid".to_owned());
    }
    if document.secrets.len() > AI_SECRETS_MAX {
        return Err(format!(
            "ai-secrets.json exceeds the {AI_SECRETS_MAX} entry ceiling"
        ));
    }
    let mut map = BTreeMap::new();
    for secret in document.secrets {
        AiCredentialId::parse(&secret.id).map_err(|_| "ai secret id is not a UUID".to_owned())?;
        // File parsing already rejects bad material; still go through AiSecretBytes::new
        // so load reconstruction shares one admission authority.
        let admitted = AiSecretBytes::new(secret.secret.clone()).map_err(|error| match error {
            junban_domain::ValidationError::Empty { .. } => {
                "ai secret value must not be empty".to_owned()
            }
            junban_domain::ValidationError::TooLong { .. } => {
                "ai secret value exceeds the 8 KiB ceiling".to_owned()
            }
            junban_domain::ValidationError::Invalid { .. } => {
                "ai secret value must not contain control characters".to_owned()
            }
            _ => "ai secret value is invalid".to_owned(),
        })?;
        // Keep durable shape; admitted bytes are identical after validation.
        let _ = admitted;
        if map.insert(secret.id.clone(), secret).is_some() {
            return Err("ai-secrets.json contains duplicate ids".to_owned());
        }
    }
    Ok((document.verification_key, map))
}

fn persist_secrets(
    path: &Path,
    verification_key: &str,
    secrets: &BTreeMap<String, StoredAiSecret>,
) -> io::Result<()> {
    let document = AiSecretsFile {
        version: AI_SECRETS_FILE_VERSION,
        verification_key: verification_key.to_owned(),
        secrets: secrets.values().cloned().collect(),
    };
    let mut json = serde_json::to_vec_pretty(&document).map_err(io::Error::other)?;
    json.push(b'\n');
    atomic_replace_private_file(path, &json)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    use junban_domain::AI_SECRET_BYTES_MAX;

    fn temp_profile() -> PathBuf {
        std::env::temp_dir().join(format!(
            "junban-ai-secrets-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn sample_secret() -> AiSecretBytes {
        // Deliberately non-token-looking fixture material.
        AiSecretBytes::new("fixture-secret-material").unwrap()
    }

    #[test]
    fn load_missing_file_is_empty() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load(&profile).unwrap();
        assert_eq!(store.list_metadata().len(), 0);
        assert!(!profile.join(AI_SECRETS_FILE).exists());
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn rejects_unknown_version_fields_duplicates_oversize_and_kinds() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join(AI_SECRETS_FILE);
        let test_key = "00".repeat(VERIFICATION_KEY_BYTES);

        fs::write(
            &path,
            format!(r#"{{"version":99,"verification_key":"{test_key}","secrets":[]}}"#),
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(
            &path,
            format!(r#"{{"version":1,"verification_key":"{test_key}","secrets":[],"extra":true}}"#),
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(&path, r#"{"version":1,"secrets":[]}"#).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(
            &path,
            r#"{"version":1,"verification_key":"invalid","secrets":[]}"#,
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(
            &path,
            format!(
                r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"not-a-uuid","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"x"}}]}}"#
            ),
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        let id = AiCredentialId::new().to_string();
        let dup = format!(
            r#"{{"version":1,"verification_key":"{test_key}","secrets":[
            {{"id":"{id}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"one"}},
            {{"id":"{id}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"two"}}
            ]}}"#
        );
        fs::write(&path, dup).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        let oversize = "x".repeat(AI_SECRET_BYTES_MAX + 1);
        let body = format!(
            r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"{}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"{oversize}"}}]}}"#,
            AiCredentialId::new()
        );
        fs::write(&path, body).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(
            &path,
            format!(
                r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"{}","kind":"oauth_token","updated_at":"2026-01-01T00:00:00Z","secret":"x"}}]}}"#,
                AiCredentialId::new()
            ),
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn verifier_key_is_durable_and_stable_across_reload() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let secret = sample_secret();
        let first = AiSecretStore::load_or_create(&profile).unwrap();
        let first_verifier = first.receipt_verifier(&secret).unwrap();
        let file_before = fs::read(profile.join(AI_SECRETS_FILE)).unwrap();

        let reloaded = AiSecretStore::load_or_create(&profile).unwrap();
        assert_eq!(reloaded.receipt_verifier(&secret).unwrap(), first_verifier);
        assert_ne!(
            reloaded
                .receipt_verifier(&AiSecretBytes::new("different-fixture").unwrap())
                .unwrap(),
            first_verifier
        );
        assert_eq!(
            fs::read(profile.join(AI_SECRETS_FILE)).unwrap(),
            file_before
        );
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn publish_list_get_delete_and_redaction() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load_or_create(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let id = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();

        let listed = store.list_metadata();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert!(listed[0].present);
        let meta_json = serde_json::to_string(&listed[0]).unwrap();
        assert!(!meta_json.contains("fixture-secret-material"));
        assert!(!meta_json.contains("secret"));

        let got = store.get_secret(&id).unwrap().unwrap();
        assert_eq!(got.expose(), "fixture-secret-material");
        assert_eq!(format!("{got:?}"), "AiSecretBytes([redacted])");
        assert!(!format!("{store:?}").contains("fixture-secret-material"));

        store.delete(&id).unwrap();
        store.delete(&id).unwrap();
        assert!(store.get_secret(&id).unwrap().is_none());
        assert_eq!(store.list_metadata().len(), 0);

        // Durable file is owner-private on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // republish to inspect mode
            let id = store
                .publish(AiSecretKind::Bearer, sample_secret(), now)
                .unwrap();
            let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let _ = id;
        }

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn publish_failure_leaves_prior_state() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load_or_create(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let first = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();

        // Replace the secrets file path with a directory so atomic replace fails.
        let path = profile.join(AI_SECRETS_FILE);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        let error = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap_err();
        assert!(matches!(error, AiSecretStoreError::Io(_)));
        assert_eq!(store.len_for_test(), 1);
        assert!(store.get_secret(&first).unwrap().is_some());

        fs::remove_dir(&path).unwrap();
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn delete_persist_failure_keeps_memory_and_durable() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load_or_create(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let id = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();

        let error = store
            .delete_with_persist_for_test(&id, |_, _, _| {
                Err(io::Error::other("injected durability failure"))
            })
            .unwrap_err();
        assert!(matches!(error, AiSecretStoreError::Io(_)));
        assert_eq!(store.len_for_test(), 1);
        let reloaded = AiSecretStore::load(&profile).unwrap();
        assert_eq!(reloaded.len_for_test(), 1);

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn reconcile_removes_only_unreferenced_ids() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load_or_create(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let keep = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();
        let drop_id = store
            .publish(AiSecretKind::Bearer, sample_secret(), now)
            .unwrap();

        let removed = store.reconcile_unreferenced(&[keep]).unwrap();
        assert_eq!(removed, 1);
        assert!(store.get_secret(&keep).unwrap().is_some());
        assert!(store.get_secret(&drop_id).unwrap().is_none());

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn secret_bytes_reject_oversize_and_controls() {
        assert!(AiSecretBytes::new("").is_err());
        assert!(AiSecretBytes::new("x".repeat(AI_SECRET_BYTES_MAX + 1)).is_err());
        assert!(AiSecretBytes::new("has\nnewline").is_err());
    }

    #[test]
    fn publish_and_load_reject_empty_oversize_control_and_corrupted_without_leaking() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load_or_create(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();

        // No public constructor bypass: only AiSecretBytes::new admits material, and
        // publish revalidates. Construct invalid candidates via raw JSON only.
        let test_key = "00".repeat(VERIFICATION_KEY_BYTES);
        let path = profile.join(AI_SECRETS_FILE);

        let marker = "corrupt-secret-marker-must-not-leak";
        for body in [
            format!(
                r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"{}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":""}}]}}"#,
                AiCredentialId::new()
            ),
            format!(
                r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"{}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"{}"}}]}}"#,
                AiCredentialId::new(),
                "x".repeat(AI_SECRET_BYTES_MAX + 1)
            ),
            format!(
                r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"{}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"has\ncontrol"}}]}}"#,
                AiCredentialId::new()
            ),
            format!(
                r#"{{"version":1,"verification_key":"{test_key}","secrets":[{{"id":"{}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"{marker}","extra":true}}]}}"#,
                AiCredentialId::new()
            ),
        ] {
            fs::write(&path, &body).unwrap();
            let error = AiSecretStore::load(&profile).unwrap_err();
            let rendered = error.to_string();
            assert!(
                !rendered.contains(marker),
                "load error leaked secret material"
            );
            assert!(!rendered.contains("has\ncontrol"));
            assert!(!format!("{error:?}").contains(marker));
        }

        // Valid publish still works and never surfaces material in errors/debug.
        let id = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();
        let got = store.get_secret(&id).unwrap().unwrap();
        assert_eq!(got.expose(), "fixture-secret-material");
        assert!(!format!("{got:?}").contains("fixture-secret-material"));

        // In-memory corruption fails closed on get without leaking bytes.
        {
            let mut guard = store.secrets.write().expect("ai secrets poisoned");
            let entry = guard.get_mut(&id.to_string()).unwrap();
            entry.secret = format!("{marker}\x00");
        }
        let error = store.get_secret(&id).unwrap_err();
        let rendered = error.to_string();
        assert!(!rendered.contains(marker));
        assert!(!format!("{error:?}").contains(marker));

        fs::remove_dir_all(profile).unwrap();
    }
}
