// SPDX-License-Identifier: MIT
// Exercises the MIL-162 portal spike (prototypes/portal-spike/) — the "prototype against a
// large (hundreds-of-slices, multi-model) test set" acceptance criterion from the ticket. Not a
// test of a shipped `em` feature (this prototype ships no CLI command); it's the automated
// regression guard behind the scale numbers cited in
// docs/decisions/mil-162-teachable-navigator.md, so those numbers don't silently drift as `em`
// itself changes.
import { describe, it, expect } from "vitest";
import { generateScaleFixture } from "../prototypes/portal-spike/scaleFixture.js";
import { runSpike, buildCrossModelLinks, renderDemoHtml, materializeFixture, compileAndExportAll } from "../prototypes/portal-spike/spike.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL_COUNT = 5;
const SLICES_PER_MODEL = 40; // 200 primary + 4 intake = 204 slices — "hundreds", CI-friendly

describe("scaleFixture.generateScaleFixture", () => {
  it("is deterministic — same inputs, byte-identical output", () => {
    const a = generateScaleFixture(MODEL_COUNT, SLICES_PER_MODEL);
    const b = generateScaleFixture(MODEL_COUNT, SLICES_PER_MODEL);
    expect(a).toEqual(b);
  });

  it("produces exactly modelCount models and the expected slice total", () => {
    const fixture = generateScaleFixture(MODEL_COUNT, SLICES_PER_MODEL);
    expect(fixture.models).toHaveLength(MODEL_COUNT);
    // slicesPerModel per model, plus one intake slice per model after the first
    expect(fixture.totalSlices).toBe(MODEL_COUNT * SLICES_PER_MODEL + (MODEL_COUNT - 1));
  });

  it("chains public events: model i's last event is exactly what model i+1's intake view cites", () => {
    const fixture = generateScaleFixture(MODEL_COUNT, SLICES_PER_MODEL);
    for (let i = 0; i < MODEL_COUNT - 1; i++) {
      expect(fixture.models[i].publicEventName).not.toBeNull();
      expect(fixture.models[i + 1].consumesEventName).toBe(fixture.models[i].publicEventName);
    }
    expect(fixture.models[MODEL_COUNT - 1].publicEventName).not.toBeNull(); // last model still marks one public — just nothing in THIS set consumes it
    expect(fixture.models[0].consumesEventName).toBeNull();
  });
});

describe("prototypes/portal-spike/spike.ts — full pipeline at scale", () => {
  it("compiles every fixture model without errors and resolves every cross-model link", () => {
    const fixture = generateScaleFixture(MODEL_COUNT, SLICES_PER_MODEL);
    const root = mkdtempSync(join(tmpdir(), "em-portal-spike-test-"));
    try {
      const materialized = materializeFixture(fixture, root);
      const { compiled } = compileAndExportAll(materialized); // throws on any compile error
      expect(compiled).toHaveLength(MODEL_COUNT);

      const links = buildCrossModelLinks(compiled);
      // Exactly one link per model boundary (MODEL_COUNT - 1 boundaries) — the whole point of
      // chaining the fixture this way: the join between independently-compiled files is exact,
      // not approximate, when both sides use the same event name.
      expect(links).toHaveLength(MODEL_COUNT - 1);
      for (const link of links) {
        expect(link.fromModel).not.toBe(link.toModel);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runSpike aggregates a real em status rollup across the whole synthetic system", async () => {
    const summary = await runSpike(MODEL_COUNT, SLICES_PER_MODEL);

    expect(summary.modelCount).toBe(MODEL_COUNT);
    expect(summary.totalSlices).toBe(MODEL_COUNT * SLICES_PER_MODEL + (MODEL_COUNT - 1));
    expect(summary.status.slices.total).toBe(summary.totalSlices);
    // Exactly one slice in the whole system has a bound doc (bindOneSliceDoc) — everything else
    // legitimately falls into the `no-doc` bucket, the realistic state for a large in-flight
    // system and the case the rollup needs to handle at scale, not just at tutorial scale.
    expect(summary.status.slices.byStatus.reviewed).toBe(1);
    expect(summary.status.slices.byStatus.noDoc).toBe(summary.totalSlices - 1);
    expect(summary.crossModelLinks).toHaveLength(MODEL_COUNT - 1);

    // Regression guard, not a precision benchmark: the whole pipeline (compile + export +
    // status + cross-model join) across ~200 slices / 5 models should stay well under a second
    // on ordinary hardware. A generous ceiling here catches a real complexity blowup without
    // making CI flaky on a loaded runner.
    expect(summary.timingMs.total).toBeLessThan(15000);
  });

  it("renders a well-formed, self-contained demo page covering all three portal properties", async () => {
    const summary = await runSpike(MODEL_COUNT, SLICES_PER_MODEL);
    const html = renderDemoHtml(summary);

    expect(html).toMatch(/^<!doctype html>/);
    expect(html.trim().endsWith("</html>")).toBe(true);
    expect(html).not.toMatch(/https?:\/\//); // fully self-contained — no external CDN/asset references
    expect(html).toContain("State up front"); // property 1
    expect(html).toContain("Guided first read"); // property 2
    expect(html).toContain("Multi-model navigation"); // property 3
    for (const model of summary.models) {
      expect(html).toContain(model.modelName);
    }
  });

  it("writes the demo HTML to disk when an output path is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "em-portal-spike-out-"));
    try {
      const outPath = join(root, "demo.html");
      const summary = await runSpike(MODEL_COUNT, SLICES_PER_MODEL, outPath);
      expect(summary.crossModelLinks.length).toBeGreaterThan(0);
      const { readFileSync, existsSync } = await import("node:fs");
      expect(existsSync(outPath)).toBe(true);
      expect(readFileSync(outPath, "utf8")).toContain("em portal — spike output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
