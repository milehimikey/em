// SPDX-License-Identifier: MIT
// Coverage for `em status`'s underlying logic (src/cli/status.ts, MIL-163): status-bucket
// classification, per-slice fact resolution (real fs fixtures, same convention as
// test/coverage.test.ts), open-issue counting, aggregation (including the frontmatter-invalid
// coherence fix and the covers:-shared-doc Open Questions dedupe, PR #116 review), commits-
// behind-HEAD (fake git, same convention as test/conformScope.test.ts/test/ledgerCheck.test.ts),
// conformance-entry resolution (including the modelPath-mismatch guard, PR #116 review), and the
// text/markdown/badge formatting layers (including the badge-color unverifiable-conformance fix,
// PR #116 review). CLI-level exit-code/flag-parsing coverage lives in test/cli.test.ts;
// MCP-tool parity coverage lives in test/mcp.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compile } from "../src/pipeline.js";
import { GitResult, GitRunner } from "../src/cli/diff-inputs.js";
import {
  classifyStatusBucket,
  resolveSliceStatusFacts,
  countOpenIssues,
  commitsBehindHead,
  resolveConformanceEntry,
  buildStatusReport,
  aggregateInvariantTotals,
  formatStatusSummary,
  formatStatusDetail,
  formatStatusText,
  formatStatusMarkdown,
  buildStatusBadge,
  renderBadgeSvg,
  StatusReport,
  SliceStatusFact,
  StatusDiagnostic,
  ConformanceEntry,
} from "../src/cli/status.js";
import { buildCoverageReport } from "../src/cli/coverage.js";

const fakeGit = (responses: GitResult[]): GitRunner => {
  let i = 0;
  return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
};
const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): GitResult => ({ status: 128, stdout: "", stderr });

describe("classifyStatusBucket", () => {
  it("buckets a not-found doc as no-doc regardless of status/reason", () => {
    expect(classifyStatusBucket(false, "no-doc-bound", null)).toBe("no-doc");
    expect(classifyStatusBucket(false, "binding-missing-file", null)).toBe("no-doc");
  });
  it("buckets each of the 4 canonical statuses to itself", () => {
    expect(classifyStatusBucket(true, null, "draft")).toBe("draft");
    expect(classifyStatusBucket(true, null, "reviewed")).toBe("reviewed");
    expect(classifyStatusBucket(true, null, "ready-to-implement")).toBe("ready-to-implement");
    expect(classifyStatusBucket(true, null, "implemented")).toBe("implemented");
  });
  it("buckets a found doc with a freeform/unrecognized status as unknown", () => {
    expect(classifyStatusBucket(true, null, "in-review")).toBe("unknown");
  });
  it("buckets a found doc with null status as unknown", () => {
    expect(classifyStatusBucket(true, null, null)).toBe("unknown");
  });
  // PR #116 review finding 2: a found-but-broken doc must bucket distinctly from both "unknown"
  // (found, usable, freeform status) and "no-doc" (nothing found at all) — found: true with
  // reason: "frontmatter-invalid" is a THIRD, coherent state.
  it("buckets a found doc with invalid frontmatter as frontmatter-invalid, not unknown", () => {
    expect(classifyStatusBucket(true, "frontmatter-invalid", null)).toBe("frontmatter-invalid");
  });
});

describe("resolveSliceStatusFacts / countOpenIssues (real fs fixtures)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-status-facts-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "checkout.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: PR#1\n---\n" +
        "## Open Questions\n- [x] resolved one\n- [ ] still open\n",
    );
    writeFileSync(
      join(dir, "slices", "billing.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: billing\nstatus: draft\nversion: 1\n---\n## Open Questions\n- [ ] one open\n",
    );
    // Bound (note-referenced) but frontmatter is missing entirely — docJoin's frontmatter-invalid
    // reason, found: true.
    writeFileSync(join(dir, "slices", "broken.md"), "# Slice: Broken\nNo frontmatter fence at all.\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const SRC = `
slice "Checkout" {
  command Place Order note "slices/checkout.md" issue "who validates the code?"
  event Order Placed
}
slice "Billing" {
  ui Invoice @Customer note "slices/billing.md"
}
slice "Untouched" {
  ui Dashboard @Customer
}
slice "Broken" {
  ui Broken Screen @Customer note "slices/broken.md"
}
`;

  it("joins each slice's doc, buckets its status, and carries drift/open-questions/docPath facts", () => {
    const { model, refs } = compile(SRC);
    const { facts, diagnostics } = resolveSliceStatusFacts("model.em", model, refs, dir);
    expect(facts).toHaveLength(4);

    const checkout = facts.find((f) => f.key === "checkout")!;
    expect(checkout.docFound).toBe(true);
    expect(checkout.bucket).toBe("implemented");
    expect(checkout.driftSignal).toBe("in-sync");
    expect(checkout.openQuestionsTotal).toBe(2);
    expect(checkout.openQuestionsUnchecked).toBe(1);
    expect(checkout.docPath).toBe(resolve(dir, "slices/checkout.md"));

    const billing = facts.find((f) => f.key === "billing")!;
    expect(billing.bucket).toBe("draft");
    expect(billing.driftSignal).toBe("never-implemented");
    expect(billing.openQuestionsUnchecked).toBe(1);

    const untouched = facts.find((f) => f.key === "untouched")!;
    expect(untouched.docFound).toBe(false);
    expect(untouched.docReason).toBe("no-doc-bound");
    expect(untouched.bucket).toBe("no-doc");
    expect(untouched.driftSignal).toBeNull();
    expect(untouched.openQuestionsTotal).toBe(0);
    expect(untouched.docPath).toBeNull();

    // PR #116 review finding 2: found: true, reason: frontmatter-invalid — bucketed distinctly,
    // and the join's warning diagnostic is surfaced, not dropped.
    const broken = facts.find((f) => f.key === "broken")!;
    expect(broken.docFound).toBe(true);
    expect(broken.docReason).toBe("frontmatter-invalid");
    expect(broken.bucket).toBe("frontmatter-invalid");
    expect(broken.driftSignal).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("frontmatter-invalid");
    expect(diagnostics[0].message).toContain("slices/broken.md");
  });

  it("countOpenIssues counts every element carrying an open issue marker", () => {
    const { model } = compile(SRC);
    expect(countOpenIssues(model)).toBe(1);
  });

  it("countOpenIssues returns 0 for a model with no issues", () => {
    const { model } = compile('slice "Clean" {\n  ui Dashboard @Customer\n}\n');
    expect(countOpenIssues(model)).toBe(0);
  });

  // PR #116 review finding 3: MIL-121 covers: cross-binding resolves two different slices to
  // the SAME doc file — resolveSliceStatusFacts should report the identical resolved docPath
  // for both (buildStatusReport is what actually dedupes, tested below). "owner.md" is bound
  // canonically by slice "Owner" (note names its OWN canonical path) and cross-bound by slice
  // "Other" (note names "Owner"'s path, ratified by owner.md's own `covers: other`) — the
  // real MIL-121 shape, not two slices independently noting a third, unrelated file.
  it("two slices cross-bound (MIL-121 covers:) to the same doc resolve to the same docPath", () => {
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "owner.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\ncovers: other\n---\n" +
        "## Open Questions\n- [ ] one shared open question\n",
    );
    const src = `
slice "Owner" {
  command Own Thing note "slices/owner.md"
  event Thing Owned
}
slice "Other" {
  ui Other Screen @Customer note "slices/owner.md"
}
`;
    const { model, refs } = compile(src);
    const { facts } = resolveSliceStatusFacts("model.em", model, refs, dir);
    const owner = facts.find((f) => f.key === "owner")!;
    const other = facts.find((f) => f.key === "other")!;
    expect(owner.docFound).toBe(true);
    expect(other.docFound).toBe(true);
    expect(owner.docPath).not.toBeNull();
    expect(owner.docPath).toBe(other.docPath);
    expect(owner.openQuestionsUnchecked).toBe(1);
    expect(other.openQuestionsUnchecked).toBe(1);
  });
});

describe("commitsBehindHead", () => {
  it("returns the parsed count on success", () => {
    const runGit = fakeGit([ok("/repo\n"), ok("3\n")]);
    const result = commitsBehindHead("/repo", "abc123", runGit);
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("fails clearly when the repo isn't a git repository", () => {
    const runGit = fakeGit([fail("not a repo")]);
    const result = commitsBehindHead("/not-a-repo", "abc123", runGit);
    expect(result).toEqual({ ok: false, message: "em status: /not-a-repo is not a git repository" });
  });

  it("fails clearly on an unknown revision", () => {
    const runGit = fakeGit([ok("/repo\n"), fail("unknown revision or path")]);
    const result = commitsBehindHead("/repo", "not-a-rev", runGit);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; message: string }).message).toContain("git rev-list failed");
  });
});

describe("resolveConformanceEntry (real fs, fake git)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-status-conformance-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports hasStateFile: false, no error, when there's no .event-modeling.md", () => {
    const entry = resolveConformanceEntry(join(dir, "model.em"), undefined, fakeGit([]));
    expect(entry).toEqual({
      file: join(dir, "model.em"),
      modelDir: dir,
      hasStateFile: false,
      lastConformance: null,
      repo: dir,
      commitsBehindHead: null,
      error: null,
    });
  });

  it("reports lastConformance: null (never conformed) when the state file's marker is never", () => {
    const d2 = mkdtempSync(join(tmpdir(), "em-status-conformance-never-"));
    try {
      writeFileSync(
        join(d2, ".event-modeling.md"),
        "- **Model file:** `model.em`\n- **Current phase:** discover\n- **Current step:** 1\n" +
          "- **Last updated:** 2026-08-01\n- **Last conformance:** never\n- **Last stakeholder review:** never\n",
      );
      const entry = resolveConformanceEntry(join(d2, "model.em"), undefined, fakeGit([]));
      expect(entry.hasStateFile).toBe(true);
      expect(entry.lastConformance).toBeNull();
      expect(entry.error).toBeNull();
      expect(entry.commitsBehindHead).toBeNull();
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("computes commitsBehindHead against --repo when Last conformance: is set", () => {
    const d3 = mkdtempSync(join(tmpdir(), "em-status-conformance-set-"));
    try {
      writeFileSync(
        join(d3, ".event-modeling.md"),
        "- **Model file:** `model.em`\n- **Current phase:** conform\n- **Current step:** 1\n" +
          "- **Last updated:** 2026-08-01\n- **Last conformance:** 2026-08-01 @ abc123f — report: conformance/2026-08-01.md\n" +
          "- **Last stakeholder review:** never\n",
      );
      const runGit = fakeGit([ok("/target-repo\n"), ok("5\n")]);
      const entry = resolveConformanceEntry(join(d3, "model.em"), "/target-repo", runGit);
      expect(entry.hasStateFile).toBe(true);
      expect(entry.lastConformance).toEqual({ date: "2026-08-01", revision: "abc123f" });
      expect(entry.repo).toBe("/target-repo");
      expect(entry.commitsBehindHead).toBe(5);
      expect(entry.error).toBeNull();
    } finally {
      rmSync(d3, { recursive: true, force: true });
    }
  });

  it("defaults repo to the model's own directory when --repo isn't given", () => {
    const d4 = mkdtempSync(join(tmpdir(), "em-status-conformance-default-repo-"));
    try {
      writeFileSync(
        join(d4, ".event-modeling.md"),
        "- **Model file:** `model.em`\n- **Current phase:** conform\n- **Current step:** 1\n" +
          "- **Last updated:** 2026-08-01\n- **Last conformance:** 2026-08-01 @ abc123f — report: r.md\n" +
          "- **Last stakeholder review:** never\n",
      );
      const runGit = fakeGit([ok(`${d4}\n`), ok("0\n")]);
      const entry = resolveConformanceEntry(join(d4, "model.em"), undefined, runGit);
      expect(entry.repo).toBe(d4);
      expect(entry.commitsBehindHead).toBe(0);
    } finally {
      rmSync(d4, { recursive: true, force: true });
    }
  });

  it("carries a non-fatal error when git can't resolve commits-behind-HEAD", () => {
    const d5 = mkdtempSync(join(tmpdir(), "em-status-conformance-giterr-"));
    try {
      writeFileSync(
        join(d5, ".event-modeling.md"),
        "- **Model file:** `model.em`\n- **Current phase:** conform\n- **Current step:** 1\n" +
          "- **Last updated:** 2026-08-01\n- **Last conformance:** 2026-08-01 @ abc123f — report: r.md\n" +
          "- **Last stakeholder review:** never\n",
      );
      const runGit = fakeGit([fail("not a repo")]);
      const entry = resolveConformanceEntry(join(d5, "model.em"), "/not-a-repo", runGit);
      expect(entry.lastConformance).toEqual({ date: "2026-08-01", revision: "abc123f" });
      expect(entry.commitsBehindHead).toBeNull();
      expect(entry.error).toContain("is not a git repository");
    } finally {
      rmSync(d5, { recursive: true, force: true });
    }
  });

  it("carries a non-fatal error when the state file itself doesn't parse", () => {
    const d6 = mkdtempSync(join(tmpdir(), "em-status-conformance-badstate-"));
    try {
      writeFileSync(join(d6, ".event-modeling.md"), "not a real state file\n");
      const entry = resolveConformanceEntry(join(d6, "model.em"), undefined, fakeGit([]));
      expect(entry.hasStateFile).toBe(true);
      expect(entry.lastConformance).toBeNull();
      expect(entry.error).toContain("state file:");
    } finally {
      rmSync(d6, { recursive: true, force: true });
    }
  });

  // PR #116 review finding 4: a state file is shared by every .em in its directory, but its
  // Model file: bullet names exactly one of them — a sibling file it doesn't describe (e.g. a
  // conform-scope --seed-asis scratch copy) must not inherit that record.
  it("does not attribute the conformance record to a sibling .em the state file's Model file: doesn't name", () => {
    const d7 = mkdtempSync(join(tmpdir(), "em-status-conformance-mismatch-"));
    try {
      writeFileSync(
        join(d7, ".event-modeling.md"),
        "- **Model file:** `checkout.em`\n- **Current phase:** conform\n- **Current step:** 1\n" +
          "- **Last updated:** 2026-08-01\n- **Last conformance:** 2026-08-01 @ abc123f — report: r.md\n" +
          "- **Last stakeholder review:** never\n",
      );
      // checkout.em itself: attributed normally.
      const runGit = fakeGit([ok(`${d7}\n`), ok("2\n")]);
      const forCheckout = resolveConformanceEntry(join(d7, "checkout.em"), undefined, runGit);
      expect(forCheckout.lastConformance).toEqual({ date: "2026-08-01", revision: "abc123f" });
      expect(forCheckout.commitsBehindHead).toBe(2);
      expect(forCheckout.error).toBeNull();

      // checkout-asis.em, same directory, same state file: NOT attributed — no git call made at
      // all (fakeGit([]) would throw "unexpected extra git call" if resolveConformanceEntry
      // tried one).
      const forAsis = resolveConformanceEntry(join(d7, "checkout-asis.em"), undefined, fakeGit([]));
      expect(forAsis.hasStateFile).toBe(true);
      expect(forAsis.lastConformance).toBeNull();
      expect(forAsis.commitsBehindHead).toBeNull();
      expect(forAsis.error).toContain('describes "checkout.em"');
      expect(forAsis.error).toContain('not "checkout-asis.em"');
    } finally {
      rmSync(d7, { recursive: true, force: true });
    }
  });

  it("still attributes the record when Model file: is absent from an otherwise-missing-bullet parse failure (covered above) — and when it IS present and matches", () => {
    const d8 = mkdtempSync(join(tmpdir(), "em-status-conformance-match-"));
    try {
      writeFileSync(
        join(d8, ".event-modeling.md"),
        "- **Model file:** `model.em`\n- **Current phase:** conform\n- **Current step:** 1\n" +
          "- **Last updated:** 2026-08-01\n- **Last conformance:** 2026-08-01 @ abc123f — report: r.md\n" +
          "- **Last stakeholder review:** never\n",
      );
      const runGit = fakeGit([ok(`${d8}\n`), ok("0\n")]);
      const entry = resolveConformanceEntry(join(d8, "model.em"), undefined, runGit);
      expect(entry.lastConformance).toEqual({ date: "2026-08-01", revision: "abc123f" });
      expect(entry.error).toBeNull();
    } finally {
      rmSync(d8, { recursive: true, force: true });
    }
  });
});

describe("aggregateInvariantTotals", () => {
  it("sums totals/uncovered across multiple CoverageReports", () => {
    const totals = aggregateInvariantTotals("test/", [
      { slices: [], totalInvariants: 5, uncoveredCount: 1 },
      { slices: [], totalInvariants: 15, uncoveredCount: 0 },
    ]);
    expect(totals).toEqual({ testsDir: "test/", total: 20, cited: 19, uncovered: 1 });
  });

  it("handles a single, empty report", () => {
    expect(aggregateInvariantTotals("test/", [{ slices: [], totalInvariants: 0, uncoveredCount: 0 }])).toEqual({
      testsDir: "test/",
      total: 0,
      cited: 0,
      uncovered: 0,
    });
  });
});

describe("buildStatusReport", () => {
  const facts: SliceStatusFact[] = [
    { file: "a.em", key: "s1", docFound: true, docReason: null, docPath: "/a/slices/s1.md", rawStatus: "implemented", bucket: "implemented", driftSignal: "in-sync", openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
    { file: "a.em", key: "s2", docFound: true, docReason: null, docPath: "/a/slices/s2.md", rawStatus: "draft", bucket: "draft", driftSignal: "never-implemented", openQuestionsTotal: 2, openQuestionsUnchecked: 1 },
    { file: "a.em", key: "s3", docFound: false, docReason: "no-doc-bound", docPath: null, rawStatus: null, bucket: "no-doc", driftSignal: null, openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
  ];
  const conformance: ConformanceEntry[] = [
    { file: "a.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc123f" }, repo: ".", commitsBehindHead: 2, error: null },
  ];

  it("tallies slices by bucket, driftSignal, and open-questions totals", () => {
    const report = buildStatusReport(["a.em"], facts, 1, null, conformance, []);
    expect(report.slices).toEqual({
      total: 3,
      byStatus: { draft: 1, reviewed: 0, readyToImplement: 0, implemented: 1, noDoc: 1, frontmatterInvalid: 0, unknown: 0 },
    });
    expect(report.driftSignal).toEqual({
      inSync: 1,
      neverImplemented: 1,
      unpropagatedDelta: 0,
      implementedWithoutLink: 0,
      notApplicable: 1,
      frontmatterInvalid: 0,
    });
    expect(report.issues).toEqual({ openIssues: 1, openQuestionsTotal: 2, openQuestionsUnchecked: 1 });
    expect(report.invariants).toBeNull();
    expect(report.conformance).toEqual(conformance);
    expect(report.files).toEqual(["a.em"]);
    expect(report.diagnostics).toEqual([]);
  });

  it("carries invariants totals through unchanged when given", () => {
    const report = buildStatusReport(["a.em"], facts, 0, { testsDir: "test/", total: 10, cited: 8, uncovered: 2 }, conformance, []);
    expect(report.invariants).toEqual({ testsDir: "test/", total: 10, cited: 8, uncovered: 2 });
  });

  it("handles zero slices without dividing by zero or throwing", () => {
    const report = buildStatusReport(["a.em"], [], 0, null, conformance, []);
    expect(report.slices.total).toBe(0);
    expect(report.slices.byStatus.implemented).toBe(0);
  });

  it("carries doc-join diagnostics through unchanged", () => {
    const diags: StatusDiagnostic[] = [{ file: "a.em", severity: "warning", code: "frontmatter-invalid", message: "broken doc", line: 3 }];
    const report = buildStatusReport(["a.em"], facts, 0, null, conformance, diags);
    expect(report.diagnostics).toEqual(diags);
  });

  // PR #116 review finding 2: a frontmatter-invalid slice tallies as its OWN bucket in both
  // dimensions, distinct from "no-doc"/notApplicable (nothing found) and "unknown" (found,
  // usable, freeform status) — the two counts always agree, since they describe the same slices.
  it("tallies a frontmatter-invalid slice coherently: same count in byStatus and driftSignal, distinct from no-doc/notApplicable", () => {
    const withBroken: SliceStatusFact[] = [
      ...facts,
      { file: "a.em", key: "broken", docFound: true, docReason: "frontmatter-invalid", docPath: "/a/slices/broken.md", rawStatus: null, bucket: "frontmatter-invalid", driftSignal: null, openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
    ];
    const report = buildStatusReport(["a.em"], withBroken, 0, null, conformance, []);
    expect(report.slices.byStatus.frontmatterInvalid).toBe(1);
    expect(report.driftSignal.frontmatterInvalid).toBe(1);
    // Not double-counted into either "no doc at all" bucket.
    expect(report.slices.byStatus.noDoc).toBe(1); // still just s3
    expect(report.driftSignal.notApplicable).toBe(1); // still just s3
    expect(report.slices.byStatus.unknown).toBe(0);
  });

  // PR #116 review finding 3: a doc shared by two slices via MIL-121 covers: contributes its
  // Open Questions ONCE, not once per covering slice.
  it("dedupes Open Questions by resolved docPath — a covers:-shared doc counts once, not per slice", () => {
    const sharedFacts: SliceStatusFact[] = [
      { file: "a.em", key: "owner", docFound: true, docReason: null, docPath: "/a/slices/shared.md", rawStatus: "reviewed", bucket: "reviewed", driftSignal: "never-implemented", openQuestionsTotal: 3, openQuestionsUnchecked: 1 },
      { file: "a.em", key: "other", docFound: true, docReason: null, docPath: "/a/slices/shared.md", rawStatus: "reviewed", bucket: "reviewed", driftSignal: "never-implemented", openQuestionsTotal: 3, openQuestionsUnchecked: 1 },
    ];
    const report = buildStatusReport(["a.em"], sharedFacts, 0, null, conformance, []);
    expect(report.issues.openQuestionsTotal).toBe(3); // not 6
    expect(report.issues.openQuestionsUnchecked).toBe(1); // not 2
    // Both slices still tally independently in the lifecycle/drift buckets — a shared doc
    // legitimately means 2 slices are "reviewed", not 1.
    expect(report.slices.byStatus.reviewed).toBe(2);
    expect(report.driftSignal.neverImplemented).toBe(2);
  });

  it("does not dedupe two DIFFERENT docs that happen to have distinct paths", () => {
    const distinctFacts: SliceStatusFact[] = [
      { file: "a.em", key: "s1", docFound: true, docReason: null, docPath: "/a/slices/one.md", rawStatus: "draft", bucket: "draft", driftSignal: "never-implemented", openQuestionsTotal: 1, openQuestionsUnchecked: 1 },
      { file: "a.em", key: "s2", docFound: true, docReason: null, docPath: "/a/slices/two.md", rawStatus: "draft", bucket: "draft", driftSignal: "never-implemented", openQuestionsTotal: 1, openQuestionsUnchecked: 1 },
    ];
    const report = buildStatusReport(["a.em"], distinctFacts, 0, null, conformance, []);
    expect(report.issues.openQuestionsTotal).toBe(2);
    expect(report.issues.openQuestionsUnchecked).toBe(2);
  });
});

describe("text/markdown/badge formatting", () => {
  function makeReport(overrides: Partial<StatusReport> = {}): StatusReport {
    return {
      files: ["model.em"],
      slices: { total: 8, byStatus: { draft: 0, reviewed: 0, readyToImplement: 0, implemented: 8, noDoc: 0, frontmatterInvalid: 0, unknown: 0 } },
      driftSignal: { inSync: 8, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 0, frontmatterInvalid: 0 },
      invariants: { testsDir: "test/", total: 20, cited: 20, uncovered: 0 },
      issues: { openIssues: 0, openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
      conformance: [
        { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc123f" }, repo: ".", commitsBehindHead: 3, error: null },
      ],
      diagnostics: [],
      ...overrides,
    };
  }

  it("formatStatusSummary renders MIL-163's acceptance line for the fully-healthy case", () => {
    const summary = formatStatusSummary(makeReport());
    expect(summary).toBe("8/8 implemented · 20/20 invariants covered · 0 open issues · last conformed abc123f, 3 commits behind HEAD");
  });

  it("formatStatusSummary reports invariants as not-checked when --tests wasn't given", () => {
    const summary = formatStatusSummary(makeReport({ invariants: null }));
    expect(summary).toContain("invariants not checked (pass --tests <dir>)");
  });

  it("formatStatusSummary pluralizes singular counts correctly", () => {
    const report = makeReport({
      issues: { openIssues: 1, openQuestionsTotal: 1, openQuestionsUnchecked: 1 },
      conformance: [{ file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc" }, repo: ".", commitsBehindHead: 1, error: null }],
    });
    const summary = formatStatusSummary(report);
    expect(summary).toContain("1 open issue,");
    expect(summary).toContain("1 unchecked open question");
    expect(summary).toContain("1 commit behind HEAD");
  });

  it("formatStatusSummary reports never conformed when there's no Last conformance:", () => {
    const report = makeReport({
      conformance: [{ file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: null, repo: ".", commitsBehindHead: null, error: null }],
    });
    expect(formatStatusSummary(report)).toContain("never conformed");
  });

  it("formatStatusSummary reports no state file distinctly from never conformed", () => {
    const report = makeReport({
      conformance: [{ file: "model.em", modelDir: ".", hasStateFile: false, lastConformance: null, repo: ".", commitsBehindHead: null, error: null }],
    });
    expect(formatStatusSummary(report)).toContain("no state file");
  });

  it("formatStatusSummary reports an unverifiable conformance state via its error, distinctly from never/no-state-file", () => {
    const report = makeReport({
      conformance: [
        { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: null, repo: ".", commitsBehindHead: null, error: "state file: missing bullet line(s)" },
      ],
    });
    expect(formatStatusSummary(report)).toContain("conformance unknown (state file: missing bullet line(s))");
  });

  it("formatStatusDetail includes one line per rollup dimension and one conformance line per model", () => {
    const detail = formatStatusDetail(makeReport());
    expect(detail).toContain("slices: 8 total");
    expect(detail).toContain("driftSignal: 8 in-sync");
    expect(detail).toContain("invariants: 20/20 covered");
    expect(detail).toContain("issues: 0 open issues");
    expect(detail).toContain("conformance: last conformed abc123f, 3 commits behind HEAD");
  });

  it("formatStatusDetail surfaces frontmatterInvalid counts in both the slices and driftSignal lines", () => {
    const report = makeReport({
      slices: { total: 9, byStatus: { draft: 0, reviewed: 0, readyToImplement: 0, implemented: 8, noDoc: 0, frontmatterInvalid: 1, unknown: 0 } },
      driftSignal: { inSync: 8, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 0, frontmatterInvalid: 1 },
    });
    const detail = formatStatusDetail(report);
    expect(detail).toContain("1 frontmatter invalid");
    expect(detail).toContain("1 n/a (frontmatter invalid)");
  });

  it("formatStatusDetail lists doc-join diagnostics when present", () => {
    const report = makeReport({
      diagnostics: [{ file: "model.em", severity: "warning", code: "frontmatter-invalid", message: "broken", line: 3 }],
    });
    const detail = formatStatusDetail(report);
    expect(detail).toContain("doc issues: 1 warning");
    expect(detail).toContain("frontmatter-invalid");
  });

  it("formatStatusDetail omits the doc-issues line when there are no diagnostics", () => {
    const detail = formatStatusDetail(makeReport());
    expect(detail).not.toContain("doc issues:");
  });

  it("formatStatusDetail labels each conformance line with its file when there are multiple models", () => {
    const report = makeReport({
      files: ["a.em", "b.em"],
      conformance: [
        { file: "a.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "aaa" }, repo: ".", commitsBehindHead: 0, error: null },
        { file: "b.em", modelDir: ".", hasStateFile: false, lastConformance: null, repo: ".", commitsBehindHead: null, error: null },
      ],
    });
    const detail = formatStatusDetail(report);
    expect(detail).toContain("conformance (a.em): last conformed aaa, 0 commits behind HEAD");
    expect(detail).toContain("conformance (b.em): no state file");
  });

  it("formatStatusText joins the summary and detail with a blank line", () => {
    const report = makeReport();
    expect(formatStatusText(report)).toBe(`${formatStatusSummary(report)}\n\n${formatStatusDetail(report)}`);
  });

  it("formatStatusMarkdown renders a metric/value table with one Last conformed row for a single model", () => {
    const md = formatStatusMarkdown(makeReport());
    expect(md).toContain("| Metric | Value |");
    expect(md).toContain("| Slices | 8/8 implemented");
    expect(md).toContain("| Invariants | 20/20 covered |");
    expect(md).toContain("| Open issues | 0 |");
    expect(md).toContain("| Last conformed | `abc123f` — 3 commits behind HEAD |");
  });

  it("formatStatusMarkdown renders one Last-conformed row per model when there are several", () => {
    const report = makeReport({
      files: ["a.em", "b.em"],
      conformance: [
        { file: "a.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "aaa" }, repo: ".", commitsBehindHead: 0, error: null },
        { file: "b.em", modelDir: ".", hasStateFile: false, lastConformance: null, repo: ".", commitsBehindHead: null, error: null },
      ],
    });
    const md = formatStatusMarkdown(report);
    expect(md).toContain("| Last conformed (a.em) |");
    expect(md).toContain("| Last conformed (b.em) |");
  });

  // CodeQL js/incomplete-sanitization, PR #116 review: escaping `|` alone on a value already
  // containing `\` (a Windows path, or free text inside a conformance `error` string) would
  // leave the pre-existing backslash adjacent to the newly-inserted one, producing `\\|` —
  // which Markdown reads as an escaped backslash followed by a live, table-breaking `|`.
  // Backslashes must escape first. Same convention/assertion shape as sliceIndex.test.ts's own
  // "escapes a pre-existing backslash before escaping `|`" test.
  it("escapes a pre-existing backslash before escaping `|` in table VALUES, so the pipe can't be un-escaped", () => {
    const report = makeReport({
      conformance: [
        { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: null, repo: ".", commitsBehindHead: null, error: "weird \\| value" },
      ],
    });
    const md = formatStatusMarkdown(report);
    expect(md).toContain("weird \\\\\\| value");
  });

  it("escapes a pre-existing backslash before escaping `|` in table KEYS (the multi-model `Last conformed (<file>)` row)", () => {
    const report = makeReport({
      files: ["a.em", "weird \\| file.em"],
      conformance: [
        { file: "a.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "aaa" }, repo: ".", commitsBehindHead: 0, error: null },
        { file: "weird \\| file.em", modelDir: ".", hasStateFile: false, lastConformance: null, repo: ".", commitsBehindHead: null, error: null },
      ],
    });
    const md = formatStatusMarkdown(report);
    expect(md).toContain("Last conformed (weird \\\\\\| file.em)");
  });

  it("renderBadgeSvg produces a well-formed, deterministic two-segment SVG", () => {
    const svg1 = renderBadgeSvg("em status", "8/8 implemented", "#4c1");
    const svg2 = renderBadgeSvg("em status", "8/8 implemented", "#4c1");
    expect(svg1).toBe(svg2); // determinism
    expect(svg1).toContain("<svg");
    expect(svg1).toContain("em status");
    expect(svg1).toContain("8/8 implemented");
    expect(svg1).toContain("#4c1");
    expect(svg1.startsWith("<svg")).toBe(true);
    expect(svg1.trim().endsWith("</svg>")).toBe(true);
  });

  it("renderBadgeSvg escapes XML-significant characters in label/message", () => {
    const svg = renderBadgeSvg("em <status>", "5 & 6", "#4c1");
    expect(svg).not.toContain("<status>");
    expect(svg).toContain("&lt;status&gt;");
    expect(svg).toContain("5 &amp; 6");
  });

  it("buildStatusBadge is green when fully implemented, covered, no open issues, and current on conformance", () => {
    const report = makeReport({
      conformance: [
        { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc123f" }, repo: ".", commitsBehindHead: 0, error: null },
      ],
    });
    const svg = buildStatusBadge(report);
    expect(svg).toContain("#4c1");
  });

  // PR #116 review finding 1: a legitimately conformance-free model (never conformed / no state
  // file yet, both error: null) stays green-eligible — this is NOT the bug the finding flagged.
  it("buildStatusBadge stays green when a model simply has no conformance history yet (no state file)", () => {
    const report = makeReport({
      conformance: [{ file: "model.em", modelDir: ".", hasStateFile: false, lastConformance: null, repo: ".", commitsBehindHead: null, error: null }],
    });
    expect(buildStatusBadge(report)).toContain("#4c1");
  });

  it("buildStatusBadge stays green when Last conformance: is the never marker", () => {
    const report = makeReport({
      conformance: [{ file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: null, repo: ".", commitsBehindHead: null, error: null }],
    });
    expect(buildStatusBadge(report)).toContain("#4c1");
  });

  it("buildStatusBadge is red when there's an open issue", () => {
    const svg = buildStatusBadge(makeReport({ issues: { openIssues: 1, openQuestionsTotal: 0, openQuestionsUnchecked: 0 } }));
    expect(svg).toContain("#e05d44");
  });

  it("buildStatusBadge is red when an invariant is uncovered", () => {
    const svg = buildStatusBadge(makeReport({ invariants: { testsDir: "test/", total: 10, cited: 9, uncovered: 1 } }));
    expect(svg).toContain("#e05d44");
  });

  it("buildStatusBadge is red when a doc claims implemented-without-link drift", () => {
    const svg = buildStatusBadge(
      makeReport({ driftSignal: { inSync: 7, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 1, notApplicable: 0, frontmatterInvalid: 0 } }),
    );
    expect(svg).toContain("#e05d44");
  });

  it("buildStatusBadge is red when a doc has invalid frontmatter", () => {
    const svg = buildStatusBadge(
      makeReport({ driftSignal: { inSync: 7, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 0, frontmatterInvalid: 1 } }),
    );
    expect(svg).toContain("#e05d44");
  });

  it("buildStatusBadge is yellow (not red) when merely not fully implemented yet", () => {
    const svg = buildStatusBadge(
      makeReport({ slices: { total: 8, byStatus: { draft: 1, reviewed: 0, readyToImplement: 0, implemented: 7, noDoc: 0, frontmatterInvalid: 0, unknown: 0 } } }),
    );
    expect(svg).toContain("#dfb317");
  });

  it("buildStatusBadge is yellow when a model is behind on conformance", () => {
    const svg = buildStatusBadge(
      makeReport({
        conformance: [{ file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "x", revision: "r" }, repo: ".", commitsBehindHead: 4, error: null }],
      }),
    );
    expect(svg).toContain("#dfb317");
  });

  // PR #116 review finding 1, the core regression: an UNRESOLVABLE conformance state
  // (commitsBehindHead: null because of an error, not because it's genuinely 0) must never
  // present as green just because `?? 0` would coalesce it to a healthy-looking number.
  it("buildStatusBadge is yellow, never green, when a conformance entry's commitsBehindHead is unresolvable due to an error", () => {
    const svg = buildStatusBadge(
      makeReport({
        conformance: [
          { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "x", revision: "r" }, repo: "/not-a-repo", commitsBehindHead: null, error: "em status: /not-a-repo is not a git repository" },
        ],
      }),
    );
    expect(svg).not.toContain("#4c1");
    expect(svg).toContain("#dfb317");
  });

  it("buildStatusBadge is yellow when the state file itself failed to parse (error set)", () => {
    const svg = buildStatusBadge(
      makeReport({
        conformance: [{ file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: null, repo: ".", commitsBehindHead: null, error: "state file: missing bullet line(s)" }],
      }),
    );
    expect(svg).not.toContain("#4c1");
    expect(svg).toContain("#dfb317");
  });

  it("buildStatusBadge is yellow when a state file describes a different model (modelPath mismatch)", () => {
    const svg = buildStatusBadge(
      makeReport({
        conformance: [
          { file: "checkout-asis.em", modelDir: ".", hasStateFile: true, lastConformance: null, repo: ".", commitsBehindHead: null, error: 'state file describes "checkout.em", not "checkout-asis.em" — not attributing its conformance record' },
        ],
      }),
    );
    expect(svg).not.toContain("#4c1");
    expect(svg).toContain("#dfb317");
  });
});

// Sanity: buildCoverageReport's real shape feeds aggregateInvariantTotals cleanly (no drift
// between the two modules' expectations of CoverageReport's fields).
describe("aggregateInvariantTotals against a real buildCoverageReport", () => {
  it("aggregates a real CoverageReport with zero invariants", () => {
    const { model, refs } = compile('slice "Clean" {\n  ui Dashboard @Customer\n}\n');
    const report = buildCoverageReport(model, refs, ".", ".");
    const totals = aggregateInvariantTotals("test/", [report]);
    expect(totals).toEqual({ testsDir: "test/", total: 0, cited: 0, uncovered: 0 });
  });
});
