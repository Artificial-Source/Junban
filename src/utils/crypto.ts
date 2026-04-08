/**
 * AES-256-GCM encryption for sensitive settings (API keys, OAuth tokens).
 *
 * Works in both Node.js (crypto module) and browser (Web Crypto API).
 * Key is derived from machine-specific data via PBKDF2.
 *
 * Encrypted format: "enc:v1:" + base64(iv + ciphertext + authTag)
 * - IV: 12 bytes (standard for GCM)
 * - Auth tag: 16 bytes
 * - PBKDF2 iterations: 100,000
 * - Key length: 256 bits
 */

import { ENCRYPTED_VALUE_PREFIX } from "./crypto-constants.js";

const SALT = "junban-aes256-v1";
const PBKDF2_ITERATIONS = 100_000;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/** Check if a value was encrypted by this module. */
export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

// ── Key derivation seed ──

function getDeviceSeed(): string {
  // Browser: use a stable-enough identifier
  if (typeof globalThis.crypto?.subtle !== "undefined" && typeof navigator !== "undefined") {
    return navigator.userAgent + "junban-encryption-key";
  }
  // Node.js: use hostname + username for a machine-specific seed
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os");
    return (os.hostname() as string) + (os.userInfo().username as string) + "junban-encryption-key";
  } catch {
    return "junban-fallback-device-seed";
  }
}

// ── Shared helpers ──

function base64Encode(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  // Browser fallback
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(str, "base64"));
  }
  // Browser fallback
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Node.js implementation ──

async function deriveKeyNode(): Promise<Buffer> {
  const crypto = await import("node:crypto");
  const seed = getDeviceSeed();
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(seed, SALT, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256", (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function encryptNode(plaintext: string): Promise<string> {
  const crypto = await import("node:crypto");
  const key = await deriveKeyNode();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Concatenate: iv + ciphertext + authTag
  const combined = new Uint8Array(iv.length + encrypted.length + authTag.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  combined.set(authTag, iv.length + encrypted.length);

  return ENCRYPTED_VALUE_PREFIX + base64Encode(combined);
}

async function decryptNode(encrypted: string): Promise<string> {
  const crypto = await import("node:crypto");
  const key = await deriveKeyNode();
  const raw = encrypted.slice(ENCRYPTED_VALUE_PREFIX.length);
  const combined = base64Decode(raw);

  const iv = combined.slice(0, IV_LENGTH);
  const authTag = combined.slice(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// ── Browser (Web Crypto) implementation ──

async function deriveKeyBrowser(): Promise<CryptoKey> {
  const seed = getDeviceSeed();
  const encoder = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(seed),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptBrowser(plaintext: string): Promise<string> {
  const key = await deriveKeyBrowser();
  const encoder = new TextEncoder();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH * 8 },
    key,
    encoder.encode(plaintext),
  );

  // Web Crypto appends authTag to ciphertext, so the result is already iv + (ciphertext+authTag)
  const encryptedBytes = new Uint8Array(encrypted);
  const combined = new Uint8Array(iv.length + encryptedBytes.length);
  combined.set(iv, 0);
  combined.set(encryptedBytes, iv.length);

  return ENCRYPTED_VALUE_PREFIX + base64Encode(combined);
}

async function decryptBrowser(encrypted: string): Promise<string> {
  const key = await deriveKeyBrowser();
  const raw = encrypted.slice(ENCRYPTED_VALUE_PREFIX.length);
  const combined = base64Decode(raw);

  const iv = combined.slice(0, IV_LENGTH);
  const data = combined.slice(IV_LENGTH); // ciphertext + authTag (Web Crypto expects them together)

  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH * 8 },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

// ── Detection: which runtime are we in? ──

function useWebCrypto(): boolean {
  return (
    typeof globalThis.crypto?.subtle !== "undefined" &&
    typeof globalThis.crypto?.getRandomValues === "function" &&
    typeof navigator !== "undefined"
  );
}

// ── Public API ──

/**
 * Encrypt a plaintext value using AES-256-GCM.
 * Returns a prefixed base64 string: "enc:v1:" + base64(iv + ciphertext + authTag).
 */
export async function encryptValue(plaintext: string): Promise<string> {
  if (useWebCrypto()) {
    return encryptBrowser(plaintext);
  }
  return encryptNode(plaintext);
}

/**
 * Decrypt an encrypted value.
 * If the value doesn't have the encryption prefix or decryption fails,
 * returns the input unchanged (graceful fallback for migration).
 */
export async function decryptValue(encrypted: string): Promise<string> {
  if (!isEncryptedValue(encrypted)) {
    return encrypted;
  }
  try {
    if (useWebCrypto()) {
      return await decryptBrowser(encrypted);
    }
    return await decryptNode(encrypted);
  } catch {
    // Graceful fallback: if decryption fails (wrong key, corrupted data),
    // return the input unchanged so the app doesn't crash during migration.
    return encrypted;
  }
}
