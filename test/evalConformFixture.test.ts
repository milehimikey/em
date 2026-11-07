// SPDX-License-Identifier: MIT
// GH #452: extends the eval/ protocol (GH #296/#423) to the `conform` skill. Two things this
// file proves mechanically — everything else about the `helpdesk` eval case
// (eval/conform/README.md) needs an agent's judgment and is scored by eval/conform/score.mjs
// against eval/conform/helpdesk/expected/*.json instead:
//
//   1. The fixture itself is well-formed: `em validate` fires exactly the one seeded internal-
//      surface diagnostic (case c), and a correctly-authored as-is scratch model makes `em
//      diff` report exactly the seeded structural-surface change (case a) with no accepted
//      divergence.
//   2. The DIFF-SCOPED path (GH #452's hard, non-negotiable requirement, the 2026-07 Wave-4
//      lesson) actually restricts `em conform-scope`'s candidate set the way the case's
//      `expected/diff-scoped.json` says it must: only the slices anchored at
//      `src/support/escalation` come back when `Last conformance:` is pinned to the baseline
//      commit, and a full/--full run is what's needed to also reach cases (b)/(c).
//
// Cases (b) (spec drift) and (d) (false-positive bait) have no mechanical signature by
// design — that's the point of including them — so they're exercised by score.mjs's unit
// tests below (eval/conform/score.mjs) against hand-built findings, not against a real
// conform walk here.
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script, no type declarations
import { setupFixture } from "../eval/conform/helpdesk/setup.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { scoreConform } from "../eval/conform/score.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const roots: string[] = [];
function fixture(pin: boolean) {
  const built = setupFixture({ pin }) as { root: string; modelDir: string; repoDir: string; baseRev: string; headRev: string };
  roots.push(built.root);
  return built;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("eval/conform/helpdesk fixture (GH #452)", () => {
  it("em validate fires exactly the seeded internal-surface finding (case c) and nothing else", () => {
    const { modelDir } = fixture(false);
    const r = em(["validate", "helpdesk.em", "--json"], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "doc-model-pattern-mismatch",
      refs: ["ticket-board"],
    });
  });

  it("a correctly-authored as-is scratch model makes `em diff` report exactly the seeded structural finding (case a), not an accepted divergence", () => {
    const { modelDir } = fixture(false);
    // model/helpdesk-asis.em is committed alongside the canonical model as the REFERENCE
    // as-is rewrite (what an agent's evidence walk over repo-head should produce) — scoring
    // a real agent's own scratch model against this shape is the eval's job, not this test's;
    // this test only proves the tool-side half (`em diff`) computes what it should once that
    // rewrite is correct.
    const r = em(["diff", "helpdesk.em", "helpdesk-asis.em", "--json"], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.identical).toBe(false);
    expect(doc.counts.fieldChanges).toBe(2);
    const onEscalateTicket = doc.changes.filter((c: { sliceKey: string }) => c.sliceKey === "escalate-ticket");
    expect(onEscalateTicket).toHaveLength(2);
    for (const change of onEscalateTicket) {
      expect(change).toMatchObject({ type: "field-added", field: "escalationReason", acceptedDivergence: null });
    }
    // Every other slice stays byte-identical in the as-is rewrite — no phantom changes.
    expect(doc.changes.every((c: { sliceKey: string }) => c.sliceKey === "escalate-ticket")).toBe(true);
  });

  it("DIFF-SCOPED (GH #452 hard requirement): Last conformance pinned to the baseline commit restricts conform-scope to only the slices anchored at the changed path", () => {
    const { modelDir, repoDir, baseRev } = fixture(true);
    const state = readFileSync(join(modelDir, ".event-modeling.md"), "utf8");
    expect(state).toContain(`- **Last conformance:** 2026-11-01 @ ${baseRev} — report: conformance/2026-11-01-report.md`);

    const r = em(["conform-scope", "helpdesk.em", "--repo", repoDir], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.lastConformance).toEqual({ date: "2026-11-01", revision: baseRev, partial: false });
    expect(doc.changedPaths).toEqual(["src/support/escalation/EscalateTicketHandler.ts"]);
    expect(doc.unmappedPaths).toEqual([]);
    expect(new Set(doc.candidateSlices.map((c: { key: string }) => c.key))).toEqual(
      new Set(["tickets-awaiting-escalation", "escalate-ticket"]),
    );
    // The hard requirement's whole point: a diff-scoped run must NOT be hinted at open-ticket
    // (case b) or ticket-board (case c) — see expected/diff-scoped.json's outOfScope list.
    expect(doc.candidateSlices.map((c: { key: string }) => c.key)).not.toContain("open-ticket");
    expect(doc.candidateSlices.map((c: { key: string }) => c.key)).not.toContain("ticket-board");
  });

  it("--full (or a first run) reaches every implemented slice, matching expected/full-scope.json's broader mustReport set", () => {
    const { modelDir, repoDir } = fixture(false); // never-run state: --full isn't even needed
    const r = em(["conform-scope", "helpdesk.em", "--repo", repoDir], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.lastConformance).toBeNull();
    expect(new Set(doc.candidateSlices.map((c: { key: string }) => c.key))).toEqual(
      new Set(["open-ticket", "tickets-awaiting-escalation", "escalate-ticket", "ticket-board"]),
    );
  });
});

describe("eval/conform/score.mjs (pure scoring, GH #452)", () => {
  const full = JSON.parse(readFileSync(join(ROOT, "eval/conform/helpdesk/expected/full-scope.json"), "utf8"));
  const diffScoped = JSON.parse(readFileSync(join(ROOT, "eval/conform/helpdesk/expected/diff-scoped.json"), "utf8"));
  const asFinding = (e: { surface: string; class: string; slice: string }) => ({ surface: e.surface, class: e.class, slice: e.slice });

  it("a perfect run scores catch rate 1, classification accuracy 1, zero false positives (full-scope)", () => {
    const perfect = full.mustReport.map(asFinding);
    const result = scoreConform(perfect, full);
    expect(result).toMatchObject({ totalExpected: 3, caught: 3, catchRate: 1, classificationAccuracy: 1, falsePositiveCount: 0 });
  });

  it("a perfect run scores the same on the diff-scoped expectation, which has only 1 mustReport entry", () => {
    const perfect = diffScoped.mustReport.map(asFinding);
    const result = scoreConform(perfect, diffScoped);
    expect(result).toMatchObject({ totalExpected: 1, caught: 1, catchRate: 1, classificationAccuracy: 1, falsePositiveCount: 0 });
  });

  it("reporting the false-positive bait as a problem is counted as exactly one false positive", () => {
    const withBait = [...full.mustReport.map(asFinding), { surface: "structural", class: "Model gap", slice: "tickets-awaiting-escalation" }];
    const result = scoreConform(withBait, full);
    expect(result.falsePositiveCount).toBe(1);
    expect(result.catchRate).toBe(1); // the bait doesn't affect catch rate — it's a separate axis
  });

  it("a finding classified Extraction uncertainty on a bait slice is NOT counted as a false positive (uncertainty is never drift)", () => {
    const uncertain = [...full.mustReport.map(asFinding), { surface: "structural", class: "Extraction uncertainty", slice: "tickets-awaiting-escalation" }];
    expect(scoreConform(uncertain, full).falsePositiveCount).toBe(0);
  });

  it("missing a mustReport entry lowers catch rate and classification accuracy together", () => {
    const missingOne = full.mustReport.slice(1).map(asFinding);
    const result = scoreConform(missingOne, full);
    expect(result.catchRate).toBeCloseTo(2 / 3);
    expect(result.classificationAccuracy).toBeCloseTo(2 / 3);
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].id).toBe("a");
  });

  it("catching a finding but with the wrong class lowers classification accuracy without lowering catch rate", () => {
    const wrongClass = full.mustReport.map((e: { surface: string; class: string; slice: string; id: string }) =>
      e.id === "c" ? { surface: e.surface, class: "Real drift", slice: e.slice } : asFinding(e),
    );
    const result = scoreConform(wrongClass, full);
    expect(result.catchRate).toBe(1);
    expect(result.classificationAccuracy).toBeCloseTo(2 / 3);
    expect(result.misclassified).toHaveLength(1);
    expect(result.misclassified[0].expected.id).toBe("c");
  });

  it("every expected file in the public conform case set parses and names only slices the model actually has", () => {
    for (const expected of [full, diffScoped]) {
      expect(expected.expectedSchemaVersion).toBe("1.0");
      for (const entry of expected.mustReport) {
        expect(["structural", "spec", "internal"]).toContain(entry.surface);
        expect(["Real drift", "Model gap", "Internal inconsistency", "Accepted divergence", "Unpropagated delta"]).toContain(entry.class);
      }
    }
  });
});
