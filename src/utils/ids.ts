const ID_LENGTH = 21;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
const ALPHABET_MASK = 63; // 6 bits = 64-char alphabet bitmask

/** Generate a unique ID for tasks, projects, and tags. */
export function generateId(): string {
  // Simple nanoid-like ID generator (21 chars, URL-safe)
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[bytes[i] & ALPHABET_MASK];
  }
  return id;
}
