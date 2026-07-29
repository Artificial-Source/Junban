import { describe, it, expect } from "vitest";
import { pathToView, viewToPath } from "./useRouting";

describe("pathToView", () => {
  it("maps /inbox to inbox", () => {
    expect(pathToView("/inbox")).toBe("inbox");
  });

  it("maps / to today", () => {
    expect(pathToView("/")).toBe("today");
  });

  it("maps /today to today", () => {
    expect(pathToView("/today")).toBe("today");
  });

  it("defaults unknown paths to today", () => {
    expect(pathToView("/unknown")).toBe("today");
  });
});

describe("viewToPath", () => {
  it("maps today to /", () => {
    expect(viewToPath("today")).toBe("/");
  });

  it("maps inbox to /inbox", () => {
    expect(viewToPath("inbox")).toBe("/inbox");
  });
});
