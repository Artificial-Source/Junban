/**
 * Incremental local AI SSE frame decoder.
 *
 * Safe across arbitrary byte chunks and UTF-8 fragmentation. Enforces frame
 * and undecoded-buffer bounds. Does not interpret envelope JSON.
 */

import { AI_SSE_MAX_BUFFER_BYTES, AI_SSE_MAX_FRAME_BYTES, AiSseError } from "./types";

export type DecodedSseFrame = {
  event: string | null;
  id: string | null;
  data: string;
  /** Wire bytes counted toward the frame bound. */
  frameBytes: number;
};

/** UTF-8 byte length (matches Rust / TextEncoder bounds). */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Incremental SSE decoder safe across arbitrary byte chunks and UTF-8
 * fragmentation. Enforces frame and undecoded-buffer bounds.
 */
export class AiSseDecoder {
  #lineCarry = "";
  #dataLines: string[] = [];
  #eventName: string | null = null;
  #eventId: string | null = null;
  #frameBytes = 0;
  #bufferBytes = 0;
  #finished = false;
  /** fatal:true rejects invalid sequences; stream:true holds incomplete tails. */
  #textDecoder = new TextDecoder("utf-8", { fatal: true });

  get undecodedBytes(): number {
    return this.#bufferBytes + utf8Bytes(this.#lineCarry);
  }

  /** Push an arbitrary body chunk; returns completed frames. */
  push(chunk: Uint8Array): DecodedSseFrame[] {
    if (this.#finished) {
      throw new AiSseError("protocol", "SSE decoder already finished");
    }
    if (chunk.byteLength === 0) {
      return [];
    }

    let text: string;
    try {
      // stream:true retains incomplete trailing code units inside the decoder.
      text = this.#textDecoder.decode(chunk, { stream: true });
    } catch {
      throw new AiSseError("utf8", "invalid UTF-8 in AI SSE body");
    }

    // Track undecoded buffer as line carry + current frame accumulation.
    this.#bufferBytes = utf8Bytes(this.#lineCarry) + this.#frameBytes;
    this.#ensureBufferBound(this.#bufferBytes + utf8Bytes(text));

    return this.#pushText(text);
  }

  /**
   * Finish the stream. A trailing partial event without a blank line is
   * dispatched when it has fields (SSE EOF rule); truncated UTF-8 is rejected.
   */
  finish(): DecodedSseFrame[] {
    if (this.#finished) {
      return [];
    }
    this.#finished = true;

    let tail = "";
    try {
      // End-of-stream flush: incomplete UTF-8 sequences fail closed.
      tail = this.#textDecoder.decode();
    } catch {
      throw new AiSseError("utf8", "truncated UTF-8 sequence at end of AI SSE body");
    }

    const frames: DecodedSseFrame[] = [];
    if (tail) {
      frames.push(...this.#pushText(tail));
    }
    if (this.#lineCarry.length > 0) {
      const line = this.#lineCarry;
      this.#lineCarry = "";
      const frame = this.#pushLine(line);
      if (frame) frames.push(frame);
    }
    if (this.#hasPendingFields()) {
      const frame = this.#dispatch();
      if (frame) frames.push(frame);
    }
    return frames;
  }

  #pushText(text: string): DecodedSseFrame[] {
    const frames: DecodedSseFrame[] = [];
    // Normalize CRLF / lone CR so fragmented endings never leave bare `\r`.
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let rest = normalized;
    while (true) {
      const newlineAt = rest.indexOf("\n");
      if (newlineAt < 0) break;
      let line = rest.slice(0, newlineAt);
      rest = rest.slice(newlineAt + 1);
      if (this.#lineCarry.length > 0) {
        line = this.#lineCarry + line;
        this.#lineCarry = "";
      }
      const frame = this.#pushLine(line);
      if (frame) frames.push(frame);
    }
    if (rest.length > 0) {
      this.#lineCarry += rest;
      this.#bufferBytes = utf8Bytes(this.#lineCarry) + this.#frameBytes;
      this.#ensureBufferBound(this.#bufferBytes);
      this.#ensureFrameBound(this.#frameBytes + utf8Bytes(this.#lineCarry));
    } else {
      this.#bufferBytes = this.#frameBytes;
    }
    return frames;
  }

  #pushLine(line: string): DecodedSseFrame | null {
    if (line.length === 0) {
      return this.#dispatch();
    }
    // Comment / keepalive.
    if (line.startsWith(":")) {
      return null;
    }

    const lineBytes = utf8Bytes(line) + 1;
    this.#frameBytes += lineBytes;
    this.#ensureFrameBound(this.#frameBytes);
    this.#bufferBytes = this.#frameBytes + utf8Bytes(this.#lineCarry);
    this.#ensureBufferBound(this.#bufferBytes);

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.#dataLines.push(value);
        break;
      case "event":
        this.#eventName = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.#eventId = value;
        }
        break;
      case "retry":
        break;
      default:
        // Ignore unknown SSE fields (forward-compatible); vendor JSON is checked later.
        break;
    }
    return null;
  }

  #dispatch(): DecodedSseFrame | null {
    if (!this.#hasPendingFields()) {
      this.#resetFrame();
      return null;
    }
    const frame: DecodedSseFrame = {
      event: this.#eventName,
      id: this.#eventId,
      data: this.#dataLines.join("\n"),
      frameBytes: this.#frameBytes,
    };
    this.#resetFrame();
    return frame;
  }

  #hasPendingFields(): boolean {
    return this.#dataLines.length > 0 || this.#eventName !== null || this.#eventId !== null;
  }

  #resetFrame(): void {
    this.#dataLines = [];
    this.#eventName = null;
    this.#eventId = null;
    this.#frameBytes = 0;
    this.#bufferBytes = utf8Bytes(this.#lineCarry);
  }

  #ensureFrameBound(bytes: number): void {
    if (bytes > AI_SSE_MAX_FRAME_BYTES) {
      throw new AiSseError("frame_bound", "AI SSE frame exceeds the configured byte bound");
    }
  }

  #ensureBufferBound(bytes: number): void {
    if (bytes > AI_SSE_MAX_BUFFER_BYTES) {
      throw new AiSseError(
        "buffer_bound",
        "AI SSE undecoded buffer exceeds the configured byte bound",
      );
    }
  }
}
