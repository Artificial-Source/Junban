import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  bootstrapFragmentToken,
  storeToken,
  getStoredToken,
  clearStoredToken,
  hasStoredToken,
  generateOperationId,
} from "./client";

describe("fragment token bootstrap", () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Reset location
    vi.stubGlobal("history", {
      ...history,
      replaceState: vi.fn(),
    });
  });

  it("saves token from #access_token=... and scrubs the fragment", () => {
    vi.stubGlobal("location", {
      ...location,
      hash: "#access_token=test-secret-token-123",
      pathname: "/today",
      search: "",
    });

    const result = bootstrapFragmentToken();
    expect(result).toBe(true);
    expect(getStoredToken()).toBe("test-secret-token-123");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/today");
  });

  it("returns false when no access_token in fragment", () => {
    vi.stubGlobal("location", {
      ...location,
      hash: "",
      pathname: "/today",
      search: "",
    });

    expect(bootstrapFragmentToken()).toBe(false);
    expect(hasStoredToken()).toBe(false);
  });

  it("returns false for unrelated fragment params", () => {
    vi.stubGlobal("location", {
      ...location,
      hash: "#foo=bar",
      pathname: "/today",
      search: "",
    });

    expect(bootstrapFragmentToken()).toBe(false);
  });
});

describe("token storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("stores and retrieves tokens from sessionStorage", () => {
    storeToken("my-token");
    expect(getStoredToken()).toBe("my-token");
    expect(hasStoredToken()).toBe(true);
  });

  it("clears tokens from sessionStorage", () => {
    storeToken("my-token");
    clearStoredToken();
    expect(getStoredToken()).toBeNull();
    expect(hasStoredToken()).toBe(false);
  });
});

describe("generateOperationId", () => {
  it("generates a valid UUID v4 string", () => {
    const id = generateOperationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateOperationId()));
    expect(ids.size).toBe(100);
  });
});
