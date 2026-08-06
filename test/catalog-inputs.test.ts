// SPDX-License-Identifier: MIT
// Coverage for `em catalog`'s input handling (src/cli/catalog-inputs.ts):
// the --format validation, matching the repo's convention of testing this
// logic at the module level (see test/glossary-inputs.test.ts).
import { describe, it, expect } from "vitest";
import { planCatalogArgs } from "../src/cli/catalog-inputs.js";

describe("planCatalogArgs", () => {
  it("defaults to svg when no --format is given", () => {
    expect(planCatalogArgs({})).toEqual({ ok: true, format: "svg" });
  });

  it("allows --format png", () => {
    expect(planCatalogArgs({ format: "png" })).toEqual({ ok: true, format: "png" });
  });

  it("allows --format svg explicitly", () => {
    expect(planCatalogArgs({ format: "svg" })).toEqual({ ok: true, format: "svg" });
  });

  it("rejects an unsupported format", () => {
    expect(planCatalogArgs({ format: "pdf" })).toEqual({
      error: "em catalog: unsupported --format 'pdf' (catalog diagrams support svg or png only)",
    });
  });
});
