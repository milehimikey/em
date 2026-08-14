// SPDX-License-Identifier: MIT
// Coverage for src/catalog/driftSignal.ts (MIL-85): the pure status/implementedIn coherence
// classification shared by `em export`'s doc join and `em validate`'s frontmatter-coherence
// check. The `unpropagated-delta` case is the load-bearing one — it's the "don't cry wolf"
// state (a re-ratified slice whose implementedIn still names prior work) that must never be
// treated the same as genuine incoherence.
import { describe, it, expect } from "vitest";
import { classifyImplementationDrift } from "../src/catalog/driftSignal.js";

describe("classifyImplementationDrift", () => {
  it("returns in-sync when implemented with a link", () => {
    expect(classifyImplementationDrift({ status: "implemented", implementedIn: "https://example.com/pr/1" })).toBe(
      "in-sync",
    );
  });

  it("returns implemented-without-link when implemented with no link", () => {
    expect(classifyImplementationDrift({ status: "implemented", implementedIn: null })).toBe(
      "implemented-without-link",
    );
  });

  it("treats a whitespace-only link as absent (implemented-without-link)", () => {
    expect(classifyImplementationDrift({ status: "implemented", implementedIn: "   " })).toBe(
      "implemented-without-link",
    );
  });

  it("returns unpropagated-delta when not implemented but a link is still present", () => {
    expect(
      classifyImplementationDrift({ status: "ready-to-implement", implementedIn: "https://example.com/pr/1" }),
    ).toBe("unpropagated-delta");
  });

  it("returns never-implemented when not implemented and no link", () => {
    expect(classifyImplementationDrift({ status: "draft", implementedIn: null })).toBe("never-implemented");
  });

  it("falls through cleanly (never-implemented) when status is null and no link", () => {
    expect(classifyImplementationDrift({ status: null, implementedIn: null })).toBe("never-implemented");
  });

  it("falls through cleanly (unpropagated-delta) when status is null but a link is present", () => {
    expect(classifyImplementationDrift({ status: null, implementedIn: "https://example.com/pr/1" })).toBe(
      "unpropagated-delta",
    );
  });
});
