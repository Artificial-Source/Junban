// TEMPORARY non-public Phase 7 Wave 0 TypeScript/JS spike guest.
// Built with exact jco 1.26.1 + componentize-js 0.22.0. Never run under Node at product runtime.

let growth = new Uint8Array(0);

export function ping(input) {
  return (input + 21) >>> 0;
}

export function forceTrap() {
  throw new Error("junban p7 spike deliberate trap");
}

export function cpuLoop() {
  let x = 0;
  for (;;) {
    x = (x + 1) | 0;
  }
}

export function growMemory(pages) {
  const add = (pages >>> 0) * 64 * 1024;
  if (add === 0) {
    return { tag: "ok", val: growth.byteLength >>> 0 };
  }
  const next = growth.byteLength + add;
  if (next > 512 * 1024 * 1024) {
    return { tag: "err", val: "guest soft cap 512MiB" };
  }
  const enlarged = new Uint8Array(next);
  enlarged.set(growth);
  enlarged[next - 1] = 0x5a;
  growth = enlarged;
  return { tag: "ok", val: growth.byteLength >>> 0 };
}
