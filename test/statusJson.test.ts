// SPDX-License-Identifier: MIT
// Coverage for `em status --json`'s serializer (src/emit/statusJson.ts): envelope shape,
// generator/schema-version fields, and that it's a faithful passthrough of `StatusReport`.
// Aggregation itself is covered by test/status.test.ts; this file tests the serialization
// layer, which is also the exact document the MCP `status` tool returns (parity is structural
// by construction — both callers hand the same StatusReport to this one function).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatusJson, STATUS_SCHEMA_VERSION } from "../src/emit/statusJson.js";
import { StatusReport } from "../src/cli/status.js";

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

function sampleReport(): StatusReport {
  return {
    files: ["model.em"],
    slices: { total: 8, byStatus: { draft: 0, reviewed: 0, readyToImplement: 0, implemented: 8, noDoc: 0, frontmatterInvalid: 0, unknown: 0 } },
    driftSignal: { inSync: 8, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 0, frontmatterInvalid: 0 },
    invariants: { testsDir: "test/", total: 20, cited: 20, uncovered: 0 },
    issues: { openIssues: 0, openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
    conformance: [
      { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc123f" }, repo: ".", commitsBehindHead: 3, error: null },
    ],
    diagnostics: [{ file: "model.em", severity: "warning", code: "frontmatter-invalid", message: "broken doc", line: 3 }],
  };
}

describe("buildStatusJson", () => {
  it("carries the schema version, generator, and every StatusReport field verbatim", () => {
    const report = sampleReport();
    const doc = JSON.parse(buildStatusJson(report));
    expect(doc.statusSchemaVersion).toBe(STATUS_SCHEMA_VERSION);
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: PKG_VERSION });
    expect(doc.files).toEqual(report.files);
    expect(doc.slices).toEqual(report.slices);
    expect(doc.driftSignal).toEqual(report.driftSignal);
    expect(doc.invariants).toEqual(report.invariants);
    expect(doc.issues).toEqual(report.issues);
    expect(doc.conformance).toEqual(report.conformance);
    expect(doc.diagnostics).toEqual([{ file: "model.em", severity: "warning", code: "frontmatter-invalid", message: "broken doc", line: 3, refs: [] }]);
  });

  it("serializes an empty diagnostics list as []", () => {
    const report = sampleReport();
    report.diagnostics = [];
    const doc = JSON.parse(buildStatusJson(report));
    expect(doc.diagnostics).toEqual([]);
  });

  it("carries invariants: null verbatim when --tests wasn't given", () => {
    const report = sampleReport();
    report.invariants = null;
    const doc = JSON.parse(buildStatusJson(report));
    expect(doc.invariants).toBeNull();
  });

  it("is pretty-printed with no trailing newline", () => {
    const json = buildStatusJson(sampleReport());
    expect(json.endsWith("\n")).toBe(false);
    expect(json).toContain("\n  ");
  });

  it("is byte-identical across two calls with the same input (determinism)", () => {
    const report = sampleReport();
    expect(buildStatusJson(report)).toBe(buildStatusJson(sampleReport()));
  });
});
