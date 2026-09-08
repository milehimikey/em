// SPDX-License-Identifier: MIT
// Coverage for src/catalog/driftSignal.ts (MIL-85, extended MIL-214): the pure
// status/implementedIn/version/conformedVersion coherence classification shared by `em export`'s
// doc join and `em validate`'s frontmatter-coherence check. The `unpropagated-delta` case is the
// original load-bearing one — it's the "don't cry wolf" state (a re-ratified slice whose
// implementedIn still names prior work) that must never be treated the same as genuine
// incoherence. `uncertified` (MIL-214) is the same shape of "expected, not a defect" state for
// certification: a slice reaches `status: implemented` long before any conform sweep runs
// against it, so "implemented but never certified" is the normal post-ship default, not drift.
import { describe, it, expect } from "vitest";
import { classifyImplementationDrift } from "../src/catalog/driftSignal.js";

describe("classifyImplementationDrift", () => {
  it("returns in-sync when implemented with a link and conformedVersion matches version", () => {
    expect(
      classifyImplementationDrift({
        status: "implemented",
        implementedIn: "https://example.com/pr/1",
        version: 1,
        conformedVersion: 1,
      }),
    ).toBe("in-sync");
  });

  it("returns uncertified when implemented with a link but conformedVersion is absent", () => {
    expect(
      classifyImplementationDrift({
        status: "implemented",
        implementedIn: "https://example.com/pr/1",
        version: 1,
        conformedVersion: null,
      }),
    ).toBe("uncertified");
  });

  it("returns uncertified when conformedVersion doesn't match the current version (reratified since)", () => {
    expect(
      classifyImplementationDrift({
        status: "implemented",
        implementedIn: "https://example.com/pr/2",
        version: 2,
        conformedVersion: 1,
      }),
    ).toBe("uncertified");
  });

  it("returns implemented-without-link when implemented with no link, regardless of conformedVersion", () => {
    expect(
      classifyImplementationDrift({ status: "implemented", implementedIn: null, version: 1, conformedVersion: 1 }),
    ).toBe("implemented-without-link");
  });

  it("treats a whitespace-only link as absent (implemented-without-link)", () => {
    expect(
      classifyImplementationDrift({ status: "implemented", implementedIn: "   ", version: 1, conformedVersion: null }),
    ).toBe("implemented-without-link");
  });

  it("returns unpropagated-delta when not implemented but a link is still present", () => {
    expect(
      classifyImplementationDrift({
        status: "ready-to-implement",
        implementedIn: "https://example.com/pr/1",
        version: 2,
        conformedVersion: 1,
      }),
    ).toBe("unpropagated-delta");
  });

  it("returns never-implemented when not implemented and no link", () => {
    expect(
      classifyImplementationDrift({ status: "draft", implementedIn: null, version: 1, conformedVersion: null }),
    ).toBe("never-implemented");
  });

  it("falls through cleanly (never-implemented) when status is null and no link", () => {
    expect(
      classifyImplementationDrift({ status: null, implementedIn: null, version: null, conformedVersion: null }),
    ).toBe("never-implemented");
  });

  it("falls through cleanly (unpropagated-delta) when status is null but a link is present", () => {
    expect(
      classifyImplementationDrift({
        status: null,
        implementedIn: "https://example.com/pr/1",
        version: null,
        conformedVersion: null,
      }),
    ).toBe("unpropagated-delta");
  });
});
