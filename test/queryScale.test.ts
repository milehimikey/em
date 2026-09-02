// SPDX-License-Identifier: MIT
// Scale/perf regression guard for `em query`'s ModelIndex (MIL-168): extends the MIL-162 portal
// spike's synthetic-system generator (prototypes/portal-spike/scaleFixture.ts) from its own
// "hundreds of slices" scale up toward ~5,000 slices across 25 models, and asserts a time
// budget on index construction plus a closure (`downstream`) and a `path` query — so "this
// should be fine at scale" is a guarded invariant, not a hope. Mirrors test/portalSpike.test.ts's
// own regression-guard framing and generous-ceiling rationale (catch a real complexity blowup,
// not make CI flaky on a loaded runner).
//
// Honest scope note: `generateScaleFixture`'s slices are each self-contained (ui -> command ->
// event, no `from`/view chaining within a model — see that module's own header on why: it's
// built to prove the CROSS-model naming-convention join, not deep intra-model dependency
// chains). So `downstream`/`path` here are genuinely 1-2 hop, not a long BFS walk — what this
// test actually stresses at ~5k-slice scale is `buildModelIndex()`'s per-model construction cost
// (refs, edges, the once-per-model slice-doc join) and a full-system `slices` scan across every
// model, which is where the real cost lives at this scale (see this ticket's report for why a
// deeper synthetic chain wasn't built to order for this test).
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateScaleFixture } from "../prototypes/portal-spike/scaleFixture.js";
import { materializeFixture } from "../prototypes/portal-spike/spike.js";
import { readFileSync } from "node:fs";
import { compileForQuery } from "../src/query/pipeline.js";
import { buildQuerySystem } from "../src/query/system.js";
import { querySlices, queryDownstream, queryPath } from "../src/query/verbs.js";

const MODEL_COUNT = 25;
const SLICES_PER_MODEL = 200; // 5,000 primary + 24 intake = 5,024 slices — "toward ~5k", CI-friendly

describe("em query at scale (~5k slices, 25 models)", () => {
  it("builds the ModelIndex for every model and answers slices/downstream/path within budget", () => {
    const fixture = generateScaleFixture(MODEL_COUNT, SLICES_PER_MODEL);
    const root = mkdtempSync(join(tmpdir(), "em-query-scale-"));
    try {
      const materialized = materializeFixture(fixture, root);

      const t0 = Date.now();
      const entries = materialized.map(({ file }) => {
        const source = readFileSync(file, "utf8");
        const compiled = compileForQuery(source, join(file, ".."));
        expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        return { file, model: compiled.model, refs: compiled.refs, index: compiled.index };
      });
      const system = buildQuerySystem(entries);
      const indexMs = Date.now() - t0;

      const t1 = Date.now();
      const all = querySlices(system, {});
      expect(all.ok).toBe(true);
      if (all.ok) expect(all.results).toHaveLength(fixture.totalSlices);
      const slicesMs = Date.now() - t1;

      // Closure + path queries, scoped to the first model's first slice (self-contained
      // ui -> command -> event, per this fixture's own shape — see header).
      const first = fixture.models[0];
      const firstSliceName = `${first.modelName} Slice 000`;
      const uiName = `${firstSliceName} Screen`;
      const eventName = `${firstSliceName} Recorded`;

      const t2 = Date.now();
      const downstream = queryDownstream(system, `${system.entries[0].modelKey}:${uiName}`);
      expect(downstream.ok).toBe(true);
      if (downstream.ok) {
        expect(downstream.results.map((r) => r.kind).sort()).toEqual(["command", "event"]);
      }
      const path = queryPath(system, uiName, eventName);
      expect(path.ok).toBe(true);
      if (path.ok) expect(path.results[0].length).toBe(2); // ui -[ui->command]-> command -[command->event]-> event
      const queryMs = Date.now() - t2;

      const totalMs = Date.now() - t0;
      // Regression guard, not a precision benchmark — same generous-ceiling rationale
      // test/portalSpike.test.ts's own scale test uses (MIL-162's spike measured compile +
      // export + status at ~71ms/1,219 slices/20 models on ordinary hardware).
      expect(totalMs).toBeLessThan(20000);

      // Surfaced for a human reading test output/CI logs, not asserted individually (a slow CI
      // runner shouldn't flake on a per-phase ceiling when the total is still comfortably under
      // budget) — see docs note above on why downstream/path are shallow here by fixture design.
      console.log(
        `em query scale: ${fixture.totalSlices} slices / ${MODEL_COUNT} models — ` +
          `index ${indexMs}ms, full slices scan ${slicesMs}ms, downstream+path ${queryMs}ms, total ${totalMs}ms`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
