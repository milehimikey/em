// SPDX-License-Identifier: MIT
// Coverage for `em status`'s underlying logic (src/cli/status.ts, MIL-163): status-bucket
// classification, per-slice fact resolution (real fs fixtures, same convention as
// test/coverage.test.ts), open-issue counting, aggregation, commits-behind-HEAD (fake git,
// same convention as test/conformScope.test.ts/test/ledgerCheck.test.ts), conformance-entry
// resolution, and the text/markdown/badge formatting layers. CLI-level exit-code/flag-parsing
// coverage lives in test/cli.test.ts; MCP-tool parity coverage lives in test/mcp.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("buckets a not-found doc as no-doc regardless of status", () => {
    expect(classifyStatusBucket(false, null)).toBe("no-doc");
  });
  it("buckets each of the 4 canonical statuses to itself", () => {
    expect(classifyStatusBucket(true, "draft")).toBe("draft");
    expect(classifyStatusBucket(true, "reviewed")).toBe("reviewed");
    expect(classifyStatusBucket(true, "ready-to-implement")).toBe("ready-to-implement");
    expect(classifyStatusBucket(true, "implemented")).toBe("implemented");
  });
  it("buckets a found doc with a freeform/unrecognized status as unknown", () => {
    expect(classifyStatusBucket(true, "in-review")).toBe("unknown");
  });
  it("buckets a found doc with null status as unknown", () => {
    expect(classifyStatusBucket(true, null)).toBe("unknown");
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
`;

  it("joins each slice's doc, buckets its status, and carries drift/open-questions facts", () => {
    const { model, refs } = compile(SRC);
    const facts = resolveSliceStatusFacts("model.em", model, refs, dir);
    expect(facts).toHaveLength(3);

    const checkout = facts.find((f) => f.key === "checkout")!;
    expect(checkout.docFound).toBe(true);
    expect(checkout.bucket).toBe("implemented");
    expect(checkout.driftSignal).toBe("in-sync");
    expect(checkout.openQuestionsTotal).toBe(2);
    expect(checkout.openQuestionsUnchecked).toBe(1);

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
  });

  it("countOpenIssues counts every element carrying an open issue marker", () => {
    const { model } = compile(SRC);
    expect(countOpenIssues(model)).toBe(1);
  });

  it("countOpenIssues returns 0 for a model with no issues", () => {
    const { model } = compile('slice "Clean" {\n  ui Dashboard @Customer\n}\n');
    expect(countOpenIssues(model)).toBe(0);
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
    { file: "a.em", key: "s1", docFound: true, docReason: null, rawStatus: "implemented", bucket: "implemented", driftSignal: "in-sync", openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
    { file: "a.em", key: "s2", docFound: true, docReason: null, rawStatus: "draft", bucket: "draft", driftSignal: "never-implemented", openQuestionsTotal: 2, openQuestionsUnchecked: 1 },
    { file: "a.em", key: "s3", docFound: false, docReason: "no-doc-bound", rawStatus: null, bucket: "no-doc", driftSignal: null, openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
  ];
  const conformance: ConformanceEntry[] = [
    { file: "a.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc123f" }, repo: ".", commitsBehindHead: 2, error: null },
  ];

  it("tallies slices by bucket, driftSignal, and open-questions totals", () => {
    const report = buildStatusReport(["a.em"], facts, 1, null, conformance);
    expect(report.slices).toEqual({
      total: 3,
      byStatus: { draft: 1, reviewed: 0, readyToImplement: 0, implemented: 1, noDoc: 1, unknown: 0 },
    });
    expect(report.driftSignal).toEqual({ inSync: 1, neverImplemented: 1, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 1 });
    expect(report.issues).toEqual({ openIssues: 1, openQuestionsTotal: 2, openQuestionsUnchecked: 1 });
    expect(report.invariants).toBeNull();
    expect(report.conformance).toEqual(conformance);
    expect(report.files).toEqual(["a.em"]);
  });

  it("carries invariants totals through unchanged when given", () => {
    const report = buildStatusReport(["a.em"], facts, 0, { testsDir: "test/", total: 10, cited: 8, uncovered: 2 }, conformance);
    expect(report.invariants).toEqual({ testsDir: "test/", total: 10, cited: 8, uncovered: 2 });
  });

  it("handles zero slices without dividing by zero or throwing", () => {
    const report = buildStatusReport(["a.em"], [], 0, null, conformance);
    expect(report.slices.total).toBe(0);
    expect(report.slices.byStatus.implemented).toBe(0);
  });
});

describe("text/markdown/badge formatting", () => {
  function makeReport(overrides: Partial<StatusReport> = {}): StatusReport {
    return {
      files: ["model.em"],
      slices: { total: 8, byStatus: { draft: 0, reviewed: 0, readyToImplement: 0, implemented: 8, noDoc: 0, unknown: 0 } },
      driftSignal: { inSync: 8, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 0, notApplicable: 0 },
      invariants: { testsDir: "test/", total: 20, cited: 20, uncovered: 0 },
      issues: { openIssues: 0, openQuestionsTotal: 0, openQuestionsUnchecked: 0 },
      conformance: [
        { file: "model.em", modelDir: ".", hasStateFile: true, lastConformance: { date: "2026-08-01", revision: "abc123f" }, repo: ".", commitsBehindHead: 3, error: null },
      ],
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

  it("formatStatusDetail includes one line per rollup dimension and one conformance line per model", () => {
    const detail = formatStatusDetail(makeReport());
    expect(detail).toContain("slices: 8 total");
    expect(detail).toContain("driftSignal: 8 in-sync");
    expect(detail).toContain("invariants: 20/20 covered");
    expect(detail).toContain("issues: 0 open issues");
    expect(detail).toContain("conformance: last conformed abc123f, 3 commits behind HEAD");
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
      makeReport({ driftSignal: { inSync: 7, neverImplemented: 0, unpropagatedDelta: 0, implementedWithoutLink: 1, notApplicable: 0 } }),
    );
    expect(svg).toContain("#e05d44");
  });

  it("buildStatusBadge is yellow (not red) when merely not fully implemented yet", () => {
    const svg = buildStatusBadge(
      makeReport({ slices: { total: 8, byStatus: { draft: 1, reviewed: 0, readyToImplement: 0, implemented: 7, noDoc: 0, unknown: 0 } } }),
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
