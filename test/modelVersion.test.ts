// SPDX-License-Identifier: MIT
// Coverage for `em model version` (src/cli/modelVersion.ts, MIL-218): deterministic manifest
// serialization, the modelHash/slices-vector computation (including MIL-208 continuation
// exclusion), bump/refuse/force, the drift predicate, and set-conformance's certify/refuse
// path. CLI wiring (`em model version bump`/`show`, `em state set-conformance`'s certify step)
// gets its own coverage in test/cli.test.ts. Neutral domain throughout (orders), per the
// engagement's non-negotiables.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import {
  computeModelHash,
  computeSlicesVector,
  findCertifiedVersion,
  latestModelVersionNumber,
  listModelVersionNumbers,
  ModelVersionManifest,
  modelVersionDrift,
  modelVersionManifestPath,
  readModelVersionManifest,
  runCertifyModelVersion,
  runModelVersionBump,
  serializeModelVersionDoc,
} from "../src/cli/modelVersion.js";

const READY_DOC =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: https://github.com/org/repo/pull/1\n---\nbody\n";

// Origin view ("Browse Orders", note-bound) plus one `again` continuation instance
// ("Orders Reflect Cancellation") — the continuation must be EXCLUDED from the slices vector
// (MIL-208), same exclusion `conformScope.ts`'s `resolveSliceDocFacts` makes.
const MODEL_SOURCE = `model "Order Versioning Fixture"

persona Ops
context Order

slice "Place Order" {
  command Place Order note "slices/place-order.md"
  event Order Placed
}
slice "Browse Orders" {
  view Orders from "Order Placed" note "slices/browse-orders.md"
  ui Orders Screen @Ops
}
slice "Cancel Order" {
  command Cancel Order
  event Order Cancelled
}
slice "Orders Reflect Cancellation" {
  view Orders again from "Order Cancelled"
  ui Orders Screen @Ops
}
`;

function sampleManifest(overrides: Partial<ModelVersionManifest> = {}): ModelVersionManifest {
  return {
    modelVersionSchemaVersion: "1.0",
    model: "orders.em",
    version: 1,
    bumpedBy: "Alex",
    bumpedOn: "2026-09-08",
    emVersion: "1.12.0",
    modelHash: "deadbeef",
    slices: { "place-order": 1, "cancel-order": null },
    certified: null,
    ...overrides,
  };
}

describe("computeModelHash", () => {
  it("is stable for identical bytes", () => {
    expect(computeModelHash("hello\nworld\n")).toBe(computeModelHash("hello\nworld\n"));
  });

  it("normalizes CRLF/CR to LF before hashing — a line-ending-only checkout diff never moves the hash", () => {
    const lf = computeModelHash("a\nb\nc\n");
    expect(computeModelHash("a\r\nb\r\nc\r\n")).toBe(lf);
    expect(computeModelHash("a\rb\rc\r")).toBe(lf);
  });

  it("changes for an actual content change", () => {
    expect(computeModelHash("a\n")).not.toBe(computeModelHash("b\n"));
  });
});

describe("serializeModelVersionDoc", () => {
  it("produces alphabetically-keyed, 2-space, trailing-newline JSON with sorted slice keys", () => {
    const text = serializeModelVersionDoc(sampleManifest({ slices: { zebra: 1, alpha: 2 } }));
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      "bumpedBy",
      "bumpedOn",
      "certified",
      "emVersion",
      "model",
      "modelHash",
      "modelVersionSchemaVersion",
      "slices",
      "version",
    ]);
    expect(Object.keys(parsed.slices)).toEqual(["alpha", "zebra"]);
  });

  it("serializes a non-null certified object with alphabetically-keyed fields", () => {
    const text = serializeModelVersionDoc(
      sampleManifest({ certified: { at: "8f12ed8", on: "2026-09-08", report: "conformance/2026-09-08-report.md", findings: null } }),
    );
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed.certified)).toEqual(["at", "findings", "on", "report"]);
  });

  it("is byte-identical across two calls with the same input (deterministic)", () => {
    const doc = sampleManifest();
    expect(serializeModelVersionDoc(doc)).toBe(serializeModelVersionDoc(doc));
  });
});

describe("computeSlicesVector", () => {
  it("keys every non-continuation slice by export key -> doc version, excluding continuations (MIL-208)", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const dir = mkdtempSync(join(tmpdir(), "em-model-version-vector-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "place-order.md"), READY_DOC);
    writeFileSync(join(dir, "slices", "browse-orders.md"), READY_DOC.replace("version: 1", "version: 3"));
    const vector = computeSlicesVector(model, refs, dir);
    rmSync(dir, { recursive: true, force: true });
    expect(vector).toEqual({
      "place-order": 1,
      "browse-orders": 3,
      "cancel-order": null, // no doc bound at all
      // "orders-reflect-cancellation" (the `again` continuation) must be ABSENT — MIL-208.
    });
    expect(Object.keys(vector)).not.toContain("orders-reflect-cancellation");
  });
});

describe("runModelVersionBump / listModelVersionNumbers / latestModelVersionNumber / readModelVersionManifest", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-model-version-bump-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports no versions and null latest before any bump", () => {
    expect(listModelVersionNumbers(dir)).toEqual([]);
    expect(latestModelVersionNumber(dir)).toBeNull();
    expect(readModelVersionManifest(dir, 1)).toBeNull();
  });

  it("refuses an empty --by", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const result = runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "   ", "2026-09-08", "1.12.0", false);
    expect(result).toEqual({ ok: false, message: "a bumper name is required (--by)" });
  });

  it("writes v1.json on the first bump", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const result = runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "Alex", "2026-09-08", "1.12.0", false);
    expect(result).toEqual({ ok: true, version: 1, path: modelVersionManifestPath(dir, 1) });
    expect(listModelVersionNumbers(dir)).toEqual([1]);
    expect(latestModelVersionNumber(dir)).toBe(1);
    const read = readModelVersionManifest(dir, 1);
    expect(read?.ok).toBe(true);
    if (!read || !read.ok) return;
    expect(read.manifest.model).toBe("orders.em");
    expect(read.manifest.bumpedBy).toBe("Alex");
    expect(read.manifest.emVersion).toBe("1.12.0");
    expect(read.manifest.certified).toBeNull();
    expect(read.manifest.modelHash).toBe(computeModelHash(MODEL_SOURCE));
  });

  it("refuses a no-op re-bump (same hash, same slices vector) without --force", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const result = runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "Alex", "2026-09-09", "1.12.0", false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("nothing has changed since v1");
    expect(result.message).toContain("--force");
    expect(listModelVersionNumbers(dir)).toEqual([1]); // nothing written
  });

  it("--force bumps anyway, writing v2.json even though nothing changed", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const result = runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "Alex", "2026-09-09", "1.12.0", true);
    expect(result).toEqual({ ok: true, version: 2, path: modelVersionManifestPath(dir, 2) });
    expect(listModelVersionNumbers(dir)).toEqual([1, 2]);
    expect(latestModelVersionNumber(dir)).toBe(2);
  });

  it("bumps to v3 without --force once the model content actually changed", () => {
    const changedSource = MODEL_SOURCE.replace('model "Order Versioning Fixture"', 'model "Order Versioning Fixture Renamed"');
    const { model, refs } = compile(changedSource);
    const result = runModelVersionBump(dir, "orders.em", model, refs, changedSource, "Sam", "2026-09-10", "1.12.0", false);
    expect(result).toEqual({ ok: true, version: 3, path: modelVersionManifestPath(dir, 3) });
  });
});

describe("modelVersionDrift", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-model-version-drift-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports no drift (current: null) when the model has never bumped", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    expect(modelVersionDrift(dir, model, refs, MODEL_SOURCE)).toEqual({ current: null, hashChanged: false, slicesChanged: [] });
  });

  it("reports no drift right after a bump", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "Alex", "2026-09-08", "1.12.0", false);
    expect(modelVersionDrift(dir, model, refs, MODEL_SOURCE)).toEqual({ current: 1, hashChanged: false, slicesChanged: [] });
  });

  it("reports hashChanged: true once the .em source changes without a re-bump", () => {
    const changedSource = MODEL_SOURCE.replace('model "Order Versioning Fixture"', 'model "Order Versioning Fixture v2"');
    const { model, refs } = compile(changedSource);
    const drift = modelVersionDrift(dir, model, refs, changedSource);
    expect(drift.current).toBe(1);
    expect(drift.hashChanged).toBe(true);
  });

  it("reports slicesChanged when a slice doc's own version bumps without a model-version re-bump", () => {
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "place-order.md"), READY_DOC.replace("version: 1", "version: 2"));
    const { model, refs } = compile(MODEL_SOURCE);
    const drift = modelVersionDrift(dir, model, refs, MODEL_SOURCE);
    expect(drift.current).toBe(1);
    expect(drift.hashChanged).toBe(false);
    expect(drift.slicesChanged).toEqual([{ key: "place-order", from: null, to: 2 }]);
  });
});

describe("findCertifiedVersion / runCertifyModelVersion", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-model-version-certify-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null before any manifest is certified", () => {
    expect(findCertifiedVersion(dir)).toBeNull();
  });

  it("refuses to certify when no manifest exists yet", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const result = runCertifyModelVersion(dir, model, refs, MODEL_SOURCE, "8f12ed8", "2026-09-08", "conformance/2026-09-08-report.md", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("bump a model version first");
  });

  it("certifies the current design version once a manifest exists", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "Alex", "2026-09-08", "1.12.0", false);
    const result = runCertifyModelVersion(dir, model, refs, MODEL_SOURCE, "8f12ed8", "2026-09-08", "conformance/2026-09-08-report.md", "conformance/2026-09-08-findings.json");
    expect(result).toEqual({ ok: true, version: 1, path: modelVersionManifestPath(dir, 1) });
    const read = readModelVersionManifest(dir, 1);
    expect(read?.ok).toBe(true);
    if (!read || !read.ok) return;
    expect(read.manifest.certified).toEqual({
      at: "8f12ed8",
      on: "2026-09-08",
      report: "conformance/2026-09-08-report.md",
      findings: "conformance/2026-09-08-findings.json",
    });
    expect(findCertifiedVersion(dir)).toEqual({
      version: 1,
      certified: { at: "8f12ed8", on: "2026-09-08", report: "conformance/2026-09-08-report.md", findings: "conformance/2026-09-08-findings.json" },
    });
  });

  it("re-certifying overwrites rather than refusing (a later revision is legal and common)", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    const result = runCertifyModelVersion(dir, model, refs, MODEL_SOURCE, "9999999", "2026-09-15", "conformance/2026-09-15-report.md", null);
    expect(result).toEqual({ ok: true, version: 1, path: modelVersionManifestPath(dir, 1) });
    const read = readModelVersionManifest(dir, 1);
    expect(read?.ok).toBe(true);
    if (!read || !read.ok) return;
    expect(read.manifest.certified).toEqual({ at: "9999999", on: "2026-09-15", report: "conformance/2026-09-15-report.md", findings: null });
  });

  it("refuses to certify once the model has drifted since the current manifest was bumped", () => {
    const changedSource = MODEL_SOURCE.replace('model "Order Versioning Fixture"', 'model "Order Versioning Fixture Drifted"');
    const { model, refs } = compile(changedSource);
    const result = runCertifyModelVersion(dir, model, refs, changedSource, "aaaaaaa", "2026-09-20", "conformance/2026-09-20-report.md", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("drifted since v1");
    expect(result.message).toContain("bump a new model version first");
  });

  it("a later design version's own certification is what findCertifiedVersion reports (newest certified wins)", () => {
    const { model, refs } = compile(MODEL_SOURCE);
    runModelVersionBump(dir, "orders.em", model, refs, MODEL_SOURCE, "Sam", "2026-09-21", "1.12.0", true);
    expect(latestModelVersionNumber(dir)).toBe(2);
    // v2 not yet certified — v1's certification is still the most recent certified fact.
    expect(findCertifiedVersion(dir)?.version).toBe(1);
    runCertifyModelVersion(dir, model, refs, MODEL_SOURCE, "bbbbbbb", "2026-09-22", "conformance/2026-09-22-report.md", null);
    expect(findCertifiedVersion(dir)?.version).toBe(2);
  });
});
