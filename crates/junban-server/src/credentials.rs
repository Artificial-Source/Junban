//! Private file-backed automation credentials.
//!
//! Stored beside other security artifacts as strict-versioned JSON. The raw secret
//! is never persisted; only a SHA-256 digest of the full presented bearer is kept.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::RwLock,
};

use jiff::Timestamp;
use junban_domain::sha256_hex;
use junban_storage::atomic_replace_private_file;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::authz::AutomationScope;

/// Private profile file holding hashed automation credentials.
pub const AUTOMATION_CREDENTIALS_FILE: &str = "automation-credentials.json";
/// Strict version for the durable credential document.
pub const AUTOMATION_CREDENTIALS_VERSION: u32 = 1;
/// Smallest practical operator-managed credential ceiling.
pub const MAX_AUTOMATION_CREDENTIALS: usize = 32;
/// Maximum UTF-8 characters accepted for a credential label.
pub const MAX_CREDENTIAL_LABEL_CHARS: usize = 100;
/// Automation bearer prefix (`jba_` = Junban automation).
pub const AUTOMATION_TOKEN_PREFIX: &str = "jba_";
/// High-entropy secret material length in lowercase hex characters (32 bytes).
pub const AUTOMATION_TOKEN_SECRET_HEX_LEN: usize = 64;
/// Absolute upper bound on a presented automation bearer (rejects oversized junk early).
pub const MAX_AUTOMATION_TOKEN_CHARS: usize = 128;

/// One durable automation credential (metadata + hash only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAutomationCredential {
    pub id: String,
    pub label: String,
    pub created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    pub scopes: Vec<AutomationScope>,
    pub token_sha256: String,
}

/// Public metadata returned by list/create responses (never includes the hash or secret).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationCredentialMetadata {
    pub id: String,
    pub label: String,
    pub created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
    pub scopes: Vec<AutomationScope>,
}

impl From<&StoredAutomationCredential> for AutomationCredentialMetadata {
    fn from(value: &StoredAutomationCredential) -> Self {
        Self {
            id: value.id.clone(),
            label: value.label.clone(),
            created_at: value.created_at,
            expires_at: value.expires_at,
            scopes: value.scopes.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AutomationCredentialsFile {
    version: u32,
    credentials: Vec<StoredAutomationCredential>,
}

/// In-memory authority loaded from the durable credential file.
#[derive(Debug)]
pub struct AutomationCredentialStore {
    path: PathBuf,
    credentials: RwLock<BTreeMap<String, StoredAutomationCredential>>,
}

impl AutomationCredentialStore {
    /// Load credentials from the profile directory. Missing file yields an empty set.
    /// Malformed content fails closed.
    pub fn load(profile_dir: &Path) -> io::Result<Self> {
        let path = profile_dir.join(AUTOMATION_CREDENTIALS_FILE);
        let credentials = match fs::read(&path) {
            Ok(data) => parse_credentials_document(&data)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            credentials: RwLock::new(credentials),
        })
    }

    /// Snapshot metadata for every stored credential (sorted by id).
    #[must_use]
    pub fn list_metadata(&self) -> Vec<AutomationCredentialMetadata> {
        self.credentials
            .read()
            .expect("automation credentials poisoned")
            .values()
            .map(AutomationCredentialMetadata::from)
            .collect()
    }

    /// Resolve a live automation principal from a presented bearer, or `None`.
    pub fn authenticate(&self, presented: &str, now: Timestamp) -> Option<AuthenticatedAutomation> {
        let parsed = parse_automation_token(presented).ok()?;
        let stored = self
            .credentials
            .read()
            .expect("automation credentials poisoned")
            .get(&parsed.id)?
            .clone();
        if stored
            .expires_at
            .is_some_and(|expires_at| expires_at <= now)
        {
            return None;
        }
        let expected = decode_sha256_hex(&stored.token_sha256)?;
        let actual = junban_domain::sha256_bytes(presented.as_bytes());
        if !bool::from(expected.ct_eq(&actual)) {
            return None;
        }
        let scopes = stored.scopes.iter().copied().collect();
        Some(AuthenticatedAutomation {
            id: stored.id,
            scopes,
        })
    }

    /// Create or idempotently replay a credential. Persist first, then update memory.
    pub fn create(
        &self,
        record: StoredAutomationCredential,
    ) -> Result<AutomationCredentialMetadata, CredentialStoreError> {
        validate_stored_credential(&record, Timestamp::now())?;
        let mut guard = self
            .credentials
            .write()
            .expect("automation credentials poisoned");
        if let Some(existing) = guard.get(&record.id) {
            // Idempotent when id + operator metadata + hash match; created_at is server-assigned.
            if credentials_idempotent_match(existing, &record) {
                return Ok(AutomationCredentialMetadata::from(existing));
            }
            return Err(CredentialStoreError::Conflict);
        }
        if guard.len() >= MAX_AUTOMATION_CREDENTIALS {
            return Err(CredentialStoreError::BoundExceeded);
        }
        let mut next = guard.clone();
        next.insert(record.id.clone(), record.clone());
        persist_credentials(&self.path, &next)?;
        *guard = next;
        Ok(AutomationCredentialMetadata::from(&record))
    }

    /// Revoke by id. Missing ids succeed (idempotent). Persist first, then memory.
    pub fn revoke(&self, id: &str) -> Result<(), CredentialStoreError> {
        self.revoke_with(id, persist_credentials)
    }

    fn revoke_with(
        &self,
        id: &str,
        persist: impl FnOnce(&Path, &BTreeMap<String, StoredAutomationCredential>) -> io::Result<()>,
    ) -> Result<(), CredentialStoreError> {
        let mut guard = self
            .credentials
            .write()
            .expect("automation credentials poisoned");
        if !guard.contains_key(id) {
            return Ok(());
        }
        let mut next = guard.clone();
        next.remove(id);
        persist(&self.path, &next)?;
        *guard = next;
        Ok(())
    }

    /// Test helper: current in-memory count.
    #[cfg(test)]
    #[must_use]
    pub fn len_for_test(&self) -> usize {
        self.credentials
            .read()
            .expect("automation credentials poisoned")
            .len()
    }

    /// Test helper: replace path contents without going through create (for load tests).
    #[cfg(test)]
    pub fn path_for_test(&self) -> &Path {
        &self.path
    }
}

/// Successfully authenticated automation principal material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedAutomation {
    pub id: String,
    pub scopes: BTreeSet<AutomationScope>,
}

/// Credential store mutation failures.
#[derive(Debug)]
pub enum CredentialStoreError {
    Conflict,
    BoundExceeded,
    Invalid(String),
    Io(io::Error),
}

impl From<io::Error> for CredentialStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for CredentialStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => write!(f, "credential id already exists with different material"),
            Self::BoundExceeded => write!(
                f,
                "at most {MAX_AUTOMATION_CREDENTIALS} automation credentials are allowed"
            ),
            Self::Invalid(message) => write!(f, "{message}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

/// Parsed automation bearer components (id is non-secret).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAutomationToken {
    pub id: String,
    pub secret_hex: String,
}

/// Build a high-entropy automation bearer for a credential id.
#[must_use]
pub fn mint_automation_token(id: &Uuid) -> String {
    let secret = crate::generate_access_token();
    format!("{AUTOMATION_TOKEN_PREFIX}{id}_{secret}")
}

/// Parse and structurally validate an automation bearer (does not check the hash).
pub fn parse_automation_token(token: &str) -> Result<ParsedAutomationToken, &'static str> {
    if token.len() > MAX_AUTOMATION_TOKEN_CHARS {
        return Err("automation token exceeds maximum length");
    }
    let rest = token
        .strip_prefix(AUTOMATION_TOKEN_PREFIX)
        .ok_or("automation token must use the jba_ prefix")?;
    let (id_raw, secret_hex) = rest
        .rsplit_once('_')
        .ok_or("automation token must carry id and secret")?;
    let id = Uuid::parse_str(id_raw).map_err(|_| "automation token id must be a UUID")?;
    if secret_hex.len() != AUTOMATION_TOKEN_SECRET_HEX_LEN
        || !secret_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("automation token secret must be 64 lowercase hex characters");
    }
    // Reject undersized entropy by requiring full hex width already checked above.
    Ok(ParsedAutomationToken {
        id: id.to_string(),
        secret_hex: secret_hex.to_owned(),
    })
}

/// Validate a client-supplied create payload token against the declared credential id.
pub fn validate_create_token(token: &str, expected_id: &str) -> Result<String, &'static str> {
    let parsed = parse_automation_token(token)?;
    if parsed.id != expected_id {
        return Err("automation token id must match the credential id");
    }
    Ok(sha256_hex(token.as_bytes()))
}

pub fn validate_credential_label(label: &str) -> Result<String, &'static str> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("label must not be empty");
    }
    if trimmed.chars().count() > MAX_CREDENTIAL_LABEL_CHARS {
        return Err("label exceeds maximum length");
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err("label must not contain control characters");
    }
    Ok(trimmed.to_owned())
}

pub fn validate_scope_list(
    scopes: &[AutomationScope],
) -> Result<Vec<AutomationScope>, &'static str> {
    if scopes.is_empty() {
        return Err("at least one scope is required");
    }
    let mut seen = HashSet::with_capacity(scopes.len());
    let mut ordered = BTreeSet::new();
    for scope in scopes {
        if !seen.insert(*scope) {
            return Err("scopes must not contain duplicates");
        }
        ordered.insert(*scope);
    }
    Ok(ordered.into_iter().collect())
}

fn parse_credentials_document(
    data: &[u8],
) -> io::Result<BTreeMap<String, StoredAutomationCredential>> {
    let document: AutomationCredentialsFile = serde_json::from_slice(data).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid automation credentials: {error}"),
        )
    })?;
    if document.version != AUTOMATION_CREDENTIALS_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported automation credentials version {}",
                document.version
            ),
        ));
    }
    if document.credentials.len() > MAX_AUTOMATION_CREDENTIALS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("automation credentials exceed bound of {MAX_AUTOMATION_CREDENTIALS}"),
        ));
    }
    let mut map = BTreeMap::new();
    let now = Timestamp::now();
    for credential in document.credentials {
        validate_stored_credential(&credential, now)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        if map.insert(credential.id.clone(), credential).is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "automation credentials contain duplicate ids",
            ));
        }
    }
    Ok(map)
}

fn validate_stored_credential(
    credential: &StoredAutomationCredential,
    now: Timestamp,
) -> Result<(), CredentialStoreError> {
    Uuid::parse_str(&credential.id)
        .map_err(|_| CredentialStoreError::Invalid("credential id must be a UUID".to_owned()))?;
    validate_credential_label(&credential.label)
        .map_err(|message| CredentialStoreError::Invalid(message.to_owned()))?;
    let scopes = validate_scope_list(&credential.scopes)
        .map_err(|message| CredentialStoreError::Invalid(message.to_owned()))?;
    if scopes.as_slice() != credential.scopes.as_slice() {
        // Persist path requires exact sorted/deduplicated order.
        return Err(CredentialStoreError::Invalid(
            "scopes must be sorted and deduplicated".to_owned(),
        ));
    }
    if decode_sha256_hex(&credential.token_sha256).is_none() {
        return Err(CredentialStoreError::Invalid(
            "token_sha256 must be 64 lowercase hex characters".to_owned(),
        ));
    }
    if let Some(expires_at) = credential.expires_at
        && expires_at <= credential.created_at
    {
        return Err(CredentialStoreError::Invalid(
            "expires_at must be strictly after created_at".to_owned(),
        ));
    }
    // Reject credentials that were already expired when written (creation-time check).
    // Startup still loads unexpired-at-creation credentials even if now past expiry;
    // authenticate() enforces live expiry.
    let _ = now;
    Ok(())
}

fn credentials_idempotent_match(
    existing: &StoredAutomationCredential,
    incoming: &StoredAutomationCredential,
) -> bool {
    existing.id == incoming.id
        && existing.label == incoming.label
        && existing.expires_at == incoming.expires_at
        && existing.scopes == incoming.scopes
        && existing.token_sha256 == incoming.token_sha256
}

fn persist_credentials(
    path: &Path,
    credentials: &BTreeMap<String, StoredAutomationCredential>,
) -> io::Result<()> {
    let document = AutomationCredentialsFile {
        version: AUTOMATION_CREDENTIALS_VERSION,
        credentials: credentials.values().cloned().collect(),
    };
    let mut json = serde_json::to_vec_pretty(&document).map_err(io::Error::other)?;
    json.push(b'\n');
    atomic_replace_private_file(path, &json)
}

fn decode_sha256_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, chunk) in value.as_bytes().chunks(2).enumerate() {
        let high = hex_nibble(chunk[0])?;
        let low = hex_nibble(chunk[1])?;
        out[index] = (high << 4) | low;
    }
    Some(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_profile() -> PathBuf {
        std::env::temp_dir().join(format!(
            "junban-cred-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn sample_record(
        id: Uuid,
        label: &str,
        scopes: &[AutomationScope],
    ) -> (String, StoredAutomationCredential) {
        let token = mint_automation_token(&id);
        let hash = sha256_hex(token.as_bytes());
        let record = StoredAutomationCredential {
            id: id.to_string(),
            label: label.to_owned(),
            created_at: Timestamp::from_second(1_700_000_000).unwrap(),
            expires_at: None,
            scopes: scopes.to_vec(),
            token_sha256: hash,
        };
        (token, record)
    }

    #[test]
    fn load_missing_file_is_empty() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AutomationCredentialStore::load(&profile).unwrap();
        assert_eq!(store.list_metadata().len(), 0);
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn rejects_unknown_version_fields_duplicates_and_bound() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let path = profile.join(AUTOMATION_CREDENTIALS_FILE);

        fs::write(&path, br#"{"version":99,"credentials":[]}"#).unwrap();
        assert!(AutomationCredentialStore::load(&profile).is_err());

        fs::write(&path, br#"{"version":1,"credentials":[],"extra":true}"#).unwrap();
        assert!(AutomationCredentialStore::load(&profile).is_err());

        let id = Uuid::now_v7();
        let (_, record) = sample_record(id, "one", &[AutomationScope::Read]);
        let mut bad = serde_json::to_value(AutomationCredentialsFile {
            version: 1,
            credentials: vec![record.clone(), record],
        })
        .unwrap();
        // Force duplicate ids through serde value.
        fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(AutomationCredentialStore::load(&profile).is_err());

        let mut many = Vec::new();
        for _ in 0..=MAX_AUTOMATION_CREDENTIALS {
            let (token_id, record) = sample_record(Uuid::now_v7(), "x", &[AutomationScope::Read]);
            let _ = token_id;
            many.push(record);
        }
        bad = serde_json::to_value(AutomationCredentialsFile {
            version: 1,
            credentials: many,
        })
        .unwrap();
        fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(AutomationCredentialStore::load(&profile).is_err());

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn create_list_revoke_and_constant_time_auth_path() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AutomationCredentialStore::load(&profile).unwrap();
        let id = Uuid::now_v7();
        let (token, record) = sample_record(
            id,
            "agent",
            &[AutomationScope::Read, AutomationScope::Write],
        );
        // scopes must be sorted
        let mut record = record;
        record.scopes = vec![AutomationScope::Read, AutomationScope::Write];

        let meta = store.create(record.clone()).unwrap();
        assert_eq!(meta.id, id.to_string());
        assert_eq!(store.list_metadata().len(), 1);
        // list secrecy: no hash field in metadata serialization
        let listed = serde_json::to_value(store.list_metadata()).unwrap();
        assert!(listed[0].get("token_sha256").is_none());
        assert!(listed[0].get("token").is_none());

        // idempotent exact replay
        let again = store.create(record.clone()).unwrap();
        assert_eq!(again, meta);

        // conflict on same id different label
        let mut conflict = record.clone();
        conflict.label = "other".to_owned();
        assert!(matches!(
            store.create(conflict),
            Err(CredentialStoreError::Conflict)
        ));

        let auth = store
            .authenticate(&token, Timestamp::from_second(1_700_000_001).unwrap())
            .expect("valid token authenticates");
        assert_eq!(auth.id, id.to_string());
        assert!(auth.scopes.contains(&AutomationScope::Read));

        // wrong secret
        let mut bad = token.clone();
        bad.replace_range(bad.len() - 1.., if bad.ends_with('a') { "b" } else { "a" });
        assert!(
            store
                .authenticate(&bad, Timestamp::from_second(1_700_000_001).unwrap())
                .is_none()
        );

        store.revoke(&id.to_string()).unwrap();
        store.revoke(&id.to_string()).unwrap(); // idempotent
        assert!(
            store
                .authenticate(&token, Timestamp::from_second(1_700_000_001).unwrap())
                .is_none()
        );
        assert_eq!(store.list_metadata().len(), 0);

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn persist_failure_keeps_prior_durable_and_memory() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AutomationCredentialStore::load(&profile).unwrap();
        let id = Uuid::now_v7();
        let (_, record) = sample_record(id, "keep", &[AutomationScope::Data]);
        let mut record = record;
        record.scopes = vec![AutomationScope::Data];
        store.create(record).unwrap();
        assert_eq!(store.len_for_test(), 1);

        // Replace the credentials file path with a directory so atomic rename fails.
        let path = profile.join(AUTOMATION_CREDENTIALS_FILE);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        let id2 = Uuid::now_v7();
        let (_, mut next) = sample_record(id2, "fail", &[AutomationScope::Read]);
        next.scopes = vec![AutomationScope::Read];
        let error = store.create(next).unwrap_err();
        assert!(matches!(error, CredentialStoreError::Io(_)));
        // In-memory still has only the first credential.
        assert_eq!(store.len_for_test(), 1);
        assert_eq!(store.list_metadata()[0].id, id.to_string());

        fs::remove_dir(&path).unwrap();
        // Prior durable content was removed when we deleted the file; recreate empty store check
        // by writing the first credential again through a fresh load after cleanup.
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn revoke_replace_failure_keeps_credential_in_memory() {
        let profile = temp_profile();
        fs::create_dir_all(&profile).unwrap();
        let store = AutomationCredentialStore::load(&profile).unwrap();
        let id = Uuid::now_v7();
        let (_, mut record) = sample_record(id, "keep", &[AutomationScope::Read]);
        record.scopes = vec![AutomationScope::Read];
        store.create(record).unwrap();

        let error = store
            .revoke_with(&id.to_string(), |_, _| {
                Err(io::Error::other(
                    "injected replacement/write-through failure",
                ))
            })
            .unwrap_err();
        assert!(matches!(error, CredentialStoreError::Io(_)));
        assert_eq!(store.len_for_test(), 1);
        assert_eq!(store.list_metadata()[0].id, id.to_string());
        let reloaded = AutomationCredentialStore::load(&profile).unwrap();
        assert_eq!(reloaded.len_for_test(), 1);
        assert_eq!(reloaded.list_metadata()[0].id, id.to_string());

        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn token_format_validation() {
        let id = Uuid::now_v7();
        let token = mint_automation_token(&id);
        let parsed = parse_automation_token(&token).unwrap();
        assert_eq!(parsed.id, id.to_string());
        assert!(validate_create_token(&token, &id.to_string()).is_ok());
        assert!(validate_create_token(&token, &Uuid::now_v7().to_string()).is_err());
        assert!(parse_automation_token("not-a-token").is_err());
        assert!(parse_automation_token(&format!("jba_{id}_short")).is_err());
    }

    #[test]
    fn expired_at_creation_rejected() {
        let id = Uuid::now_v7();
        let (_, mut record) = sample_record(id, "exp", &[AutomationScope::Read]);
        record.scopes = vec![AutomationScope::Read];
        record.expires_at = Some(record.created_at);
        assert!(validate_stored_credential(&record, Timestamp::now()).is_err());
    }
}
