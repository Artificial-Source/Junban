/**
 * Convert durable UTF-8 byte offsets into JavaScript string indices
 * without splitting multibyte code points.
 */

const encoder = new TextEncoder();

/**
 * Map a UTF-8 byte offset into a UTF-16 code-unit index for `text`.
 * Clamps to `[0, text.length]`. Never splits a multibyte character:
 * if the offset lands inside a code point, the index stays before it.
 */
export function utf8ByteOffsetToStringIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (bytes + charBytes > byteOffset) {
      return index;
    }
    bytes += charBytes;
    index += char.length;
    if (bytes === byteOffset) {
      return index;
    }
  }
  return text.length;
}

/** UTF-8 byte length of a JS string. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Bound a string to at most `maxBytes` UTF-8 bytes without splitting
 * a multibyte character.
 */
export function boundUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const charBytes = encoder.encode(char).length;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    index += char.length;
  }
  return text.slice(0, index);
}
