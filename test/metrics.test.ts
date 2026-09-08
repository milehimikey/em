// SPDX-License-Identifier: MIT
// Coverage for `em metrics --from <rev>`'s core logic (src/cli/metrics.ts): the three
// git-history-computable pilot metrics (MIL-170). Real tmp git repos via `mkdtempSync` + `git
// init` + scripted commits at fixed author dates (same `commitAt` convention test/cli.test.ts's
// "em changelog (CLI, real git repo)" suite uses) — the module's own git calls are exercised
// directly (no fake GitRunner, no CLI subprocess), since `--date=format:%Y-%m-%d` walking and
// multi-commit history is far more legible against a real repo than a hand-built response queue.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMetrics, formatMetricsText } from "../src/cli/metrics.js";

const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env });

const commitAt = (cwd: string, date: string, message: string) =>
  git(["commit", "-qam", message], cwd, {
    ...process.env,
    GIT_AUTHOR_DATE: `${date}T10:00:00`,
    GIT_COMMITTER_DATE: `${date}T10:00:00`,
  });

function doc(status: string, version: number, extra = ""): string {
  return `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: ${version}\n${extra}---\nbody text.\n`;
}

function stateFile(lastConformance: string): string {
  return (
    "# State\n\n" +
    "- **Model file:** `model.em`\n" +
    "- **Current phase:** implement\n" +
    "- **Current step:** n/a\n" +
    "- **Last updated:** 2026-01-01\n" +
    `- **Last conformance:** ${lastConformance}\n` +
    "- **Last stakeholder review:** never\n"
  );
}

describe("computeMetrics: ratification turnaround", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-metrics-turnaround-"));
    git(["init", "-q", "-b", "main"], repo);

    writeFileSync(join(repo, "model.em"), 'slice "Checkout" {}\n');
    mkdirSync(join(repo, "slices"), { recursive: true });
    writeFileSync(join(repo, "slices", "checkout.md"), doc("draft", 1));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-01", "draft checkout");
    git(["tag", "start"], repo);

    writeFileSync(join(repo, "slices", "checkout.md"), doc("reviewed", 1, "reviewedOn: 2026-01-05\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-05", "review checkout");

    writeFileSync(join(repo, "slices", "checkout.md"), doc("ready-to-implement", 1, "reviewedOn: 2026-01-05\nratifiedOn: 2026-01-08\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-08", "ratify checkout");

    writeFileSync(
      join(repo, "slices", "checkout.md"),
      doc("implemented", 1, "reviewedOn: 2026-01-05\nratifiedOn: 2026-01-08\nimplementedIn: PR#1\n"),
    );
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-15", "ship checkout");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reports the review->ratify and ratify->implement gaps for the one touched slice", () => {
    const result = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { slices, reviewToRatify, ratifyToImplement } = result.result.ratificationTurnaround;
    expect(slices).toHaveLength(1);
    const s = slices[0];
    expect(s.key).toBe("checkout");
    expect(s.reviewedOn?.date).toBe("2026-01-05");
    expect(s.ratifiedOn?.date).toBe("2026-01-08");
    expect(s.implementedIn?.date).toBe("2026-01-15");
    expect(s.reviewToRatifyDays).toBe(3);
    expect(s.ratifyToImplementDays).toBe(7);
    expect(reviewToRatify).toEqual({ count: 1, medianDays: 3, minDays: 3, maxDays: 3 });
    expect(ratifyToImplement).toEqual({ count: 1, medianDays: 7, minDays: 7, maxDays: 7 });
  });

  it("reports null events/gaps for a slice untouched in the range", () => {
    const result = computeMetrics(join(repo, "model.em"), "HEAD", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.ratificationTurnaround.slices).toEqual([]);
    expect(result.result.ratificationTurnaround.reviewToRatify).toEqual({ count: 0, medianDays: null, minDays: null, maxDays: null });
  });

  it("the text report includes the per-slice line and the stats line", () => {
    const result = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = formatMetricsText(result.result);
    expect(text).toContain("checkout: reviewed 2026-01-05, ratified 2026-01-08 (3d), implemented 2026-01-15 (7d)");
    expect(text).toContain("reviewed -> ratified: 1 slice, median 3d, min 3d, max 3d");
  });
});

describe("computeMetrics: conform cadence + findings", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-metrics-cadence-"));
    git(["init", "-q", "-b", "main"], repo);

    writeFileSync(join(repo, "model.em"), 'slice "Checkout" {}\n');
    writeFileSync(join(repo, ".event-modeling.md"), stateFile("never"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-01", "scaffold");
    git(["tag", "start"], repo);

    // First report: findings.json lands in the SAME commit, revisionSource "findings".
    mkdirSync(join(repo, "conformance"), { recursive: true });
    writeFileSync(join(repo, "conformance", "2026-01-10-report.md"), "# Conformance report\n\n### 1. a finding\n");
    writeFileSync(
      join(repo, "conformance", "2026-01-10-findings.json"),
      JSON.stringify(
        {
          findingsSchemaVersion: "1.0",
          model: "model.em",
          report: "conformance/2026-01-10-report.md",
          revision: "deadbeef",
          findings: [
            { id: 1, surface: "spec", class: "Real drift", slice: "checkout", evidence: "e", locus: "code", resolvedBy: "amy", resolvedOn: "2026-01-10" },
            { id: 2, surface: "spec", class: "Real drift", slice: "checkout", evidence: "e2", locus: null, resolvedBy: null, resolvedOn: null },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(repo, ".event-modeling.md"), stateFile("2026-01-10 @ deadbeef — report: conformance/2026-01-10-report.md"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-10", "first conform run");

    // Second report: no findings.json at all — revisionSource falls back to the state marker.
    writeFileSync(join(repo, "conformance", "2026-01-16-report.md"), "# Conformance report\n\nno findings this time\n");
    writeFileSync(join(repo, ".event-modeling.md"), stateFile("2026-01-16 @ cafebabe — report: conformance/2026-01-16-report.md"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-01-16", "second conform run");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reads counts from the findings file and the revision from it when present", () => {
    const result = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { entries, medianCadenceDays } = result.result.conformCadence;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      date: "2026-01-10",
      path: "conformance/2026-01-10-report.md",
      revision: "deadbeef",
      revisionSource: "findings",
      findingsCount: 2,
      ruledCount: 1,
      unruledCount: 1,
      daysSincePrevious: null,
    });
    expect(entries[1]).toMatchObject({
      date: "2026-01-16",
      path: "conformance/2026-01-16-report.md",
      revision: "cafebabe",
      revisionSource: "state",
      findingsCount: null,
      ruledCount: null,
      unruledCount: null,
      daysSincePrevious: 6,
    });
    expect(medianCadenceDays).toBe(6);
  });

  it("returns an empty metric, not an error, for a repo with no conformance dir", () => {
    const bareRepo = mkdtempSync(join(tmpdir(), "em-metrics-no-conformance-"));
    try {
      git(["init", "-q", "-b", "main"], bareRepo);
      writeFileSync(join(bareRepo, "model.em"), 'slice "Checkout" {}\n');
      git(["add", "-A"], bareRepo);
      commitAt(bareRepo, "2026-01-01", "start");
      git(["tag", "start"], bareRepo);
      writeFileSync(join(bareRepo, "model.em"), 'slice "Checkout" {}\nslice "Ship" {}\n');
      git(["add", "-A"], bareRepo);
      commitAt(bareRepo, "2026-01-02", "unrelated change");

      const result = computeMetrics(join(bareRepo, "model.em"), "start", "HEAD");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.conformCadence).toEqual({ entries: [], medianCadenceDays: null });
    } finally {
      rmSync(bareRepo, { recursive: true, force: true });
    }
  });
});

describe("computeMetrics: status-vs-reality disagreement", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-metrics-drift-"));
    git(["init", "-q", "-b", "main"], repo);

    writeFileSync(join(repo, "model.em"), 'slice "Checkout" {}\n');
    mkdirSync(join(repo, "slices"), { recursive: true });
    writeFileSync(join(repo, "slices", "checkout.md"), doc("draft", 1));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-02-01", "draft checkout");
    git(["tag", "start"], repo);

    // implemented + linked, never certified -> "uncertified" (a disagreement).
    writeFileSync(join(repo, "slices", "checkout.md"), doc("implemented", 1, "implementedIn: PR#9\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-02-05", "ship checkout, uncertified");

    // conformedVersion now agrees with version -> "in-sync" (no longer a disagreement).
    writeFileSync(join(repo, "slices", "checkout.md"), doc("implemented", 1, "implementedIn: PR#9\nconformedVersion: 1\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-02-06", "certify checkout");

    // a second slice: re-ratified after shipping — status flips off implemented, but
    // implementedIn is still set -> "unpropagated-delta", never a disagreement.
    writeFileSync(join(repo, "slices", "refund.md"), doc("implemented", 1, "implementedIn: PR#20\nconformedVersion: 1\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-02-10", "ship refund");

    writeFileSync(join(repo, "slices", "refund.md"), doc("ready-to-implement", 2, "implementedIn: PR#20\nconformedVersion: 1\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-02-12", "re-ratify refund");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("builds a time series across every commit touching slices/, and a matching current value", () => {
    const result = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { series, current } = result.result.statusVsReality;
    expect(series.map((p) => [p.date, p.disagreementCount, p.unpropagatedCount])).toEqual([
      ["2026-02-05", 1, 0], // checkout: uncertified
      ["2026-02-06", 0, 0], // checkout: certified -> in-sync
      ["2026-02-10", 0, 0], // refund: in-sync
      ["2026-02-12", 0, 1], // refund: re-ratified -> unpropagated-delta
    ]);
    expect(current).toEqual({ disagreementCount: 0, unpropagatedCount: 1 });
  });
});

describe("computeMetrics: determinism, empty range, and refusals", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-metrics-determinism-"));
    git(["init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "model.em"), 'slice "Checkout" {}\n');
    mkdirSync(join(repo, "slices"), { recursive: true });
    writeFileSync(join(repo, "slices", "checkout.md"), doc("reviewed", 1, "reviewedOn: 2026-03-01\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-03-01", "start");
    git(["tag", "start"], repo);
    writeFileSync(join(repo, "slices", "checkout.md"), doc("ready-to-implement", 1, "reviewedOn: 2026-03-01\nratifiedOn: 2026-03-04\n"));
    git(["add", "-A"], repo);
    commitAt(repo, "2026-03-04", "ratify");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("produces byte-identical JSON across two runs of the same range", () => {
    const a = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    const b = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    expect(a.ok && b.ok).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("an empty range (from === to) reports empty/null metrics, not an error", () => {
    const result = computeMetrics(join(repo, "model.em"), "HEAD", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.ratificationTurnaround.slices).toEqual([]);
    expect(result.result.conformCadence.entries).toEqual([]);
    expect(result.result.statusVsReality.series).toEqual([]);
    expect(result.result.readinessGateEffect).toBeNull();
  });

  it("refuses on an unknown --from revision", () => {
    const result = computeMetrics(join(repo, "model.em"), "not-a-real-rev", "HEAD");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unknown revision "not-a-real-rev"');
  });

  it("refuses on an unknown --to revision", () => {
    const result = computeMetrics(join(repo, "model.em"), "start", "not-a-real-rev");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unknown revision "not-a-real-rev"');
  });

  it("refuses when the anchor file isn't inside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "em-metrics-no-repo-"));
    try {
      writeFileSync(join(outside, "model.em"), 'slice "Checkout" {}\n');
      const result = computeMetrics(join(outside, "model.em"), "HEAD~1", "HEAD");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("is not inside a git repository");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("readinessGateEffect is always null, and the text report says so plainly", () => {
    const result = computeMetrics(join(repo, "model.em"), "start", "HEAD");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.readinessGateEffect).toBeNull();
    const text = formatMetricsText(result.result);
    expect(text).toContain("Readiness-gate effect: not computable from history — see docs/usage-data.md");
  });
});
