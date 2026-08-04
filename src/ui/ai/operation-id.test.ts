import { describe, expect, it } from "vitest";
import { RetainedOperationId, createAiOperationId, resolveOperationId } from "./operation-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("operation-id", () => {
  it("mints UUID operation ids", () => {
    const id = createAiOperationId();
    expect(id).toMatch(UUID_RE);
  });

  it("reuses an explicit id and retains across retries", () => {
    const existing = "11111111-1111-4111-8111-111111111111";
    expect(resolveOperationId(existing)).toBe(existing);

    const retained = new RetainedOperationId();
    expect(retained.assigned).toBe(false);
    const first = retained.id;
    expect(retained.assigned).toBe(true);
    expect(retained.id).toBe(first);
    expect(resolveOperationId(first)).toBe(first);
  });
});
