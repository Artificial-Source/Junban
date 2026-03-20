/**
 * Encrypted settings wrapper.
 *
 * Transparently encrypts/decrypts sensitive setting values (API keys, OAuth tokens)
 * before storing in / reading from the underlying IStorage backend.
 *
 * Non-sensitive keys pass through unchanged.
 * Existing plaintext values are returned as-is and will be encrypted on next write.
 */

import type { IStorage } from "./interface.js";
import { encryptValue, decryptValue, isEncryptedValue } from "../utils/crypto.js";

/** Setting keys that contain sensitive data and should be encrypted at rest. */
const SENSITIVE_KEYS = new Set(["ai_api_key", "ai_oauth_token", "ai_base_url_override"]);

/** Check if a setting key should be encrypted. */
export function isSensitiveSetting(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * Read a setting, decrypting if it's a sensitive key with an encrypted value.
 * Non-encrypted values for sensitive keys are returned as-is (migration support).
 */
export async function getSecureSetting(
  storage: IStorage,
  key: string,
): Promise<string | null> {
  const row = storage.getAppSetting(key);
  if (!row?.value) return null;

  if (isSensitiveSetting(key)) {
    return decryptValue(row.value);
  }
  return row.value;
}

/**
 * Write a setting, encrypting if it's a sensitive key.
 * Empty/falsy values are stored as-is (no encryption needed for empty strings).
 */
export async function setSecureSetting(
  storage: IStorage,
  key: string,
  value: string,
): Promise<void> {
  if (isSensitiveSetting(key) && value) {
    const encrypted = await encryptValue(value);
    storage.setAppSetting(key, encrypted);
  } else {
    storage.setAppSetting(key, value);
  }
}

/**
 * Check if a stored sensitive value is already encrypted.
 * Useful for migration detection.
 */
export function isSettingEncrypted(storage: IStorage, key: string): boolean {
  const row = storage.getAppSetting(key);
  if (!row?.value) return false;
  return isEncryptedValue(row.value);
}
