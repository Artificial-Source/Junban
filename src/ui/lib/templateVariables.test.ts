import { describe, expect, it } from "vitest";
import { extractTemplateVariables } from "./templateVariables";

describe("extractTemplateVariables", () => {
  it("returns unique names in first-seen order across title and description", () => {
    expect(
      extractTemplateVariables("Prepare {{thing}} for {{person}}", "Notes: {{thing}} / {{extra}}"),
    ).toEqual(["thing", "person", "extra"]);
  });

  it("returns an empty list when there are no placeholders", () => {
    expect(extractTemplateVariables("Plain title", "No vars here")).toEqual([]);
    expect(extractTemplateVariables(null, undefined, "")).toEqual([]);
  });

  it("trims interior whitespace but keeps the bare name", () => {
    expect(extractTemplateVariables("Fix: {{ issue }}")).toEqual(["issue"]);
  });
});
