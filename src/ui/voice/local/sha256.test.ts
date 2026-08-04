import { describe, expect, it } from "vitest";
import { Sha256, sha256HexOfBuffer } from "./sha256.ts";

describe("incremental SHA-256", () => {
  it("matches empty and known digests", async () => {
    expect(new Sha256().digest()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const hello = new TextEncoder().encode("hello");
    expect(new Sha256().update(hello).digest()).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    // Fragmented updates equal one-shot.
    const h = new Sha256();
    h.update(hello.subarray(0, 2));
    h.update(hello.subarray(2));
    expect(h.digest()).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("handles multi-block inputs", () => {
    const data = new Uint8Array(200);
    for (let i = 0; i < data.length; i += 1) data[i] = i & 0xff;
    const one = new Sha256().update(data).digest();
    const split = new Sha256();
    split.update(data.subarray(0, 13));
    split.update(data.subarray(13, 100));
    split.update(data.subarray(100));
    expect(split.digest()).toBe(one);
  });

  it("sha256HexOfBuffer agrees for small buffers", async () => {
    const data = new TextEncoder().encode("junban");
    const a = await sha256HexOfBuffer(data);
    const b = new Sha256().update(data).digest();
    expect(a).toBe(b);
  });
});
