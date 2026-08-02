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

use jiff::Timestamp;
use junban_domain::{
    AI_SECRET_BYTES_MAX, AI_SECRETS_FILE, AI_SECRETS_FILE_VERSION, AI_SECRETS_MAX, AiCredentialId,
    AiSecretKind, AiSecretMetadata,
};
use serde::{Deserialize, Serialize};

use crate::atomic_replace_private_file;

/// Opaque secret material. Never implements Serialize or content-bearing Debug.
#[derive(Clone)]
pub struct AiSecretBytes(String);

impl AiSecretBytes {
    pub fn new(value: impl Into<String>) -> Result<Self, AiSecretStoreError> {
        let value = value.into();
        if value.is_empty() {
            return Err(AiSecretStoreError::Invalid("secret must not be empty"));
        }
        if value.len() > AI_SECRET_BYTES_MAX {
            return Err(AiSecretStoreError::Invalid(
                "secret exceeds the 8 KiB per-entry ceiling",
            ));
        }
        if value.chars().any(|ch| ch.is_control()) {
            return Err(AiSecretStoreError::Invalid(
                "secret must not contain control characters",
            ));
        }
        Ok(Self(value))
    }

    /// Borrow the raw secret for an in-memory provider request only.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AiSecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AiSecretBytes([redacted])")
    }
}

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
    secrets: Vec<StoredAiSecret>,
}

/// In-memory authority loaded from the durable private secrets file.
pub struct AiSecretStore {
    path: PathBuf,
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
    /// Load secrets from the profile directory. Missing file yields an empty set.
    /// Malformed content, unknown versions/fields/kinds, duplicates, and oversize fail closed.
    pub fn load(profile_dir: &Path) -> io::Result<Self> {
        let path = profile_dir.join(AI_SECRETS_FILE);
        let secrets = match fs::read(&path) {
            Ok(data) => parse_secrets_document(&data).map_err(io::Error::other)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            secrets: RwLock::new(secrets),
        })
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
    pub fn get_secret(&self, id: &AiCredentialId) -> Option<AiSecretBytes> {
        self.secrets
            .read()
            .expect("ai secrets poisoned")
            .get(&id.to_string())
            .map(|stored| AiSecretBytes(stored.secret.clone()))
    }

    /// Atomically publish a new unreferenced secret and return its stable ID.
    ///
    /// Does not modify settings. A failed publication leaves the prior file intact.
    pub fn publish(
        &self,
        kind: AiSecretKind,
        secret: AiSecretBytes,
        now: Timestamp,
    ) -> Result<AiCredentialId, AiSecretStoreError> {
        let id = AiCredentialId::new();
        let record = StoredAiSecret {
            id: id.to_string(),
            kind,
            updated_at: now,
            secret: secret.0,
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
        persist_secrets(&self.path, &next)?;
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
        persist: impl FnOnce(&Path, &BTreeMap<String, StoredAiSecret>) -> io::Result<()>,
    ) -> Result<(), AiSecretStoreError> {
        let key = id.to_string();
        let mut guard = self.secrets.write().expect("ai secrets poisoned");
        if !guard.contains_key(&key) {
            return Ok(());
        }
        let mut next = guard.clone();
        next.remove(&key);
        persist(&self.path, &next)?;
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
        persist_secrets(&self.path, &next)?;
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
        persist: impl FnOnce(&Path, &BTreeMap<String, StoredAiSecret>) -> io::Result<()>,
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

fn parse_secrets_document(data: &[u8]) -> Result<BTreeMap<String, StoredAiSecret>, String> {
    let document: AiSecretsFile = serde_json::from_slice(data)
        .map_err(|error| format!("invalid ai-secrets.json: {error}"))?;
    if document.version != AI_SECRETS_FILE_VERSION {
        return Err(format!(
            "unsupported ai-secrets.json version {}",
            document.version
        ));
    }
    if document.secrets.len() > AI_SECRETS_MAX {
        return Err(format!(
            "ai-secrets.json exceeds the {AI_SECRETS_MAX} entry ceiling"
        ));
    }
    let mut map = BTreeMap::new();
    for secret in document.secrets {
        AiCredentialId::parse(&secret.id).map_err(|_| "ai secret id is not a UUID".to_owned())?;
        if secret.secret.is_empty() {
            return Err("ai secret value must not be empty".to_owned());
        }
        if secret.secret.len() > AI_SECRET_BYTES_MAX {
            return Err("ai secret value exceeds the 8 KiB ceiling".to_owned());
        }
        if secret.secret.chars().any(|ch| ch.is_control()) {
            return Err("ai secret value must not contain control characters".to_owned());
        }
        if map.insert(secret.id.clone(), secret).is_some() {
            return Err("ai-secrets.json contains duplicate ids".to_owned());
        }
    }
    Ok(map)
}

fn persist_secrets(path: &Path, secrets: &BTreeMap<String, StoredAiSecret>) -> io::Result<()> {
    let document = AiSecretsFile {
        version: AI_SECRETS_FILE_VERSION,
        secrets: secrets.values().cloned().collect(),
    };
    let mut json = serde_json::to_vec_pretty(&document).map_err(io::Error::other)?;
    json.push(b'\n');
    atomic_replace_private_file(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn rejects_unknown_version_fields_duplicates_oversize_and_kinds() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join(AI_SECRETS_FILE);

        fs::write(&path, br#"{"version":99,"secrets":[]}"#).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(&path, br#"{"version":1,"secrets":[],"extra":true}"#).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(
            &path,
            br#"{"version":1,"secrets":[{"id":"not-a-uuid","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"x"}]}"#,
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        let id = AiCredentialId::new().to_string();
        let dup = format!(
            r#"{{"version":1,"secrets":[
            {{"id":"{id}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"one"}},
            {{"id":"{id}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"two"}}
            ]}}"#
        );
        fs::write(&path, dup).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        let oversize = "x".repeat(AI_SECRET_BYTES_MAX + 1);
        let body = format!(
            r#"{{"version":1,"secrets":[{{"id":"{}","kind":"api_key","updated_at":"2026-01-01T00:00:00Z","secret":"{oversize}"}}]}}"#,
            AiCredentialId::new()
        );
        fs::write(&path, body).unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::write(
            &path,
            format!(
                r#"{{"version":1,"secrets":[{{"id":"{}","kind":"oauth_token","updated_at":"2026-01-01T00:00:00Z","secret":"x"}}]}}"#,
                AiCredentialId::new()
            ),
        )
        .unwrap();
        assert!(AiSecretStore::load(&profile).is_err());

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn publish_list_get_delete_and_redaction() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load(&profile).unwrap();
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

        let got = store.get_secret(&id).unwrap();
        assert_eq!(got.expose(), "fixture-secret-material");
        assert_eq!(format!("{got:?}"), "AiSecretBytes([redacted])");
        assert!(!format!("{store:?}").contains("fixture-secret-material"));

        store.delete(&id).unwrap();
        store.delete(&id).unwrap();
        assert!(store.get_secret(&id).is_none());
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
        let store = AiSecretStore::load(&profile).unwrap();
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
        assert!(store.get_secret(&first).is_some());

        fs::remove_dir(&path).unwrap();
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn delete_persist_failure_keeps_memory_and_durable() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AiSecretStore::load(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let id = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();

        let error = store
            .delete_with_persist_for_test(&id, |_, _| {
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
        let store = AiSecretStore::load(&profile).unwrap();
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let keep = store
            .publish(AiSecretKind::ApiKey, sample_secret(), now)
            .unwrap();
        let drop_id = store
            .publish(AiSecretKind::Bearer, sample_secret(), now)
            .unwrap();

        let removed = store.reconcile_unreferenced(&[keep]).unwrap();
        assert_eq!(removed, 1);
        assert!(store.get_secret(&keep).is_some());
        assert!(store.get_secret(&drop_id).is_none());

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn secret_bytes_reject_oversize_and_controls() {
        assert!(AiSecretBytes::new("").is_err());
        assert!(AiSecretBytes::new("x".repeat(AI_SECRET_BYTES_MAX + 1)).is_err());
        assert!(AiSecretBytes::new("has\nnewline").is_err());
    }
}
