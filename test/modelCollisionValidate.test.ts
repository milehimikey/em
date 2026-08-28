// SPDX-License-Identifier: MIT
// Coverage for src/catalog/modelCollisionValidate.ts (MIL-160): the one cross-model check in
// the codebase — every other diagnostic in model/rules.ts is raised from inside a single
// model's own compile, but colliding slice-doc paths only exist when two DIFFERENT models are
// considered together, which only ever happens in `em status`/`em catalog`.
import { describe, it, expect } from "vitest";
import { detectSliceDocCollisions } from "../src/catalog/modelCollisionValidate.js";

describe("detectSliceDocCollisions", () => {
  it("returns [] for a single model", () => {
    expect(detectSliceDocCollisions([{ file: "checkout.em", sliceKeys: ["add-item", "checkout"] }])).toEqual([]);
  });

  it("returns [] for two models in DIFFERENT directories, even with identical slice keys", () => {
    const diags = detectSliceDocCollisions([
      { file: "checkout/checkout.em", sliceKeys: ["add-item"] },
      { file: "fulfillment/fulfillment.em", sliceKeys: ["add-item"] },
    ]);
    expect(diags).toEqual([]);
  });

  it("returns [] for two models in the SAME directory with disjoint slice keys", () => {
    const diags = detectSliceDocCollisions([
      { file: "models/checkout.em", sliceKeys: ["add-item"] },
      { file: "models/fulfillment.em", sliceKeys: ["ship-order"] },
    ]);
    expect(diags).toEqual([]);
  });

  it("flags a colliding key shared by two models in the same directory, attributed to the SECOND file", () => {
    const diags = detectSliceDocCollisions([
      { file: "models/checkout.em", sliceKeys: ["checkout", "add-item"] },
      { file: "models/fulfillment.em", sliceKeys: ["ship-order", "checkout"] },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "warning",
      code: "cross-model-slice-doc-collision",
      refs: ["checkout", "models/checkout.em", "models/fulfillment.em"],
    });
    expect(diags[0].message).toContain('"models/fulfillment.em" and "models/checkout.em"');
    expect(diags[0].message).toContain('slice key "checkout"');
    expect(diags[0].message).toContain("slices/checkout.md");
  });

  it("flags every colliding key independently when more than one collides", () => {
    const diags = detectSliceDocCollisions([
      { file: "models/a.em", sliceKeys: ["checkout", "billing"] },
      { file: "models/b.em", sliceKeys: ["checkout", "billing"] },
    ]);
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.refs?.[0]).sort()).toEqual(["billing", "checkout"]);
  });

  it("does not flag a collision across a 3-way directory group beyond the first repeat, per key", () => {
    // Same key reused by a 3rd model in the same dir: the 3rd still collides with the FIRST
    // model to use it (not the 2nd), same "first wins" semantics as computeRefs()'s dedupe.
    const diags = detectSliceDocCollisions([
      { file: "models/a.em", sliceKeys: ["checkout"] },
      { file: "models/b.em", sliceKeys: [] },
      { file: "models/c.em", sliceKeys: ["checkout"] },
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].refs).toEqual(["checkout", "models/a.em", "models/c.em"]);
  });

  it("treats relative-path variants of the same directory as the same directory", () => {
    const diags = detectSliceDocCollisions([
      { file: "./models/a.em", sliceKeys: ["checkout"] },
      { file: "models/b.em", sliceKeys: ["checkout"] },
    ]);
    expect(diags).toHaveLength(1);
  });

  it("does not double-flag the same file listed twice on the command line", () => {
    const diags = detectSliceDocCollisions([
      { file: "models/a.em", sliceKeys: ["checkout"] },
      { file: "models/a.em", sliceKeys: ["checkout"] },
    ]);
    expect(diags).toEqual([]);
  });

  it("returns [] for an empty input list", () => {
    expect(detectSliceDocCollisions([])).toEqual([]);
  });
});
