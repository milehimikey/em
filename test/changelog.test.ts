// SPDX-License-Identifier: MIT
// Coverage for `em changelog`'s pure module (src/emit/changelog.ts):
// - parseDecisionsLog: dated bullets, continuation lines, missing section,
//   non-dated placeholders, and markdown tolerance.
// - buildChangelog: markdown assembly, newest-first ordering, skip-empty,
//   error sections, the first-commit introduction, and the unmatched-
//   decisions trailer.
// Git interaction (src/cli/changelog-git.ts) and the CLI wiring get their own
// coverage in test/cli.test.ts, spawning the real CLI against a scratch repo.
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { diffModels, ModelDiff } from "../src/model/diff.js";
import {
  buildChangelog,
  parseDecisionsLog,
  ChangelogEntry,
  ChangelogOptions,
  DecisionEntry,
} from "../src/emit/changelog.js";

const modelOf = (src: string) => compile(src).model;
const diffOf = (oldSrc: string, newSrc: string) => diffModels(modelOf(oldSrc), modelOf(newSrc));

const EMPTY_COUNTS = {
  slicesAdded: 0,
  slicesRemoved: 0,
  elementsAdded: 0,
  elementsRemoved: 0,
  elementsMoved: 0,
  fieldChanges: 0,
  fromChanges: 0,
  noteChanges: 0,
  issuesOpened: 0,
  issuesResolved: 0,
  issuesChanged: 0,
  arrowsAdded: 0,
  arrowsRemoved: 0,
};

/** A no-op diff: identical model on both sides, so `hasChanges()` is false. */
const NO_CHANGE_DIFF: ModelDiff = { changes: [], removals: [], counts: { ...EMPTY_COUNTS } };

const opts = (file = "model.em", intro: ChangelogOptions["intro"] = { slices: 1, elements: 2 }): ChangelogOptions => ({
  file,
  intro,
});

describe("parseDecisionsLog", () => {
  it("parses a single dated bullet", () => {
    const text = `# State\n\n## Decisions log\n- 2026-01-05: chose Stripe over Braintree — cheaper fees\n`;
    expect(parseDecisionsLog(text)).toEqual([
      { date: "2026-01-05", text: "chose Stripe over Braintree — cheaper fees" },
    ]);
  });

  it("parses multiple dated bullets in document order", () => {
    const text = `## Decisions log\n- 2026-01-01: first\n- 2026-01-02: second\n`;
    expect(parseDecisionsLog(text)).toEqual([
      { date: "2026-01-01", text: "first" },
      { date: "2026-01-02", text: "second" },
    ]);
  });

  it("folds continuation lines into the preceding bullet's text", () => {
    const text = [
      "## Decisions log",
      "- 2026-01-05: chose Stripe",
      "  because fees were lower",
      "  and the integration was already built",
      "- 2026-01-06: next decision",
    ].join("\n");
    expect(parseDecisionsLog(text)).toEqual([
      { date: "2026-01-05", text: "chose Stripe because fees were lower and the integration was already built" },
      { date: "2026-01-06", text: "next decision" },
    ]);
  });

  it("stops continuation at the next heading, not just the next bullet", () => {
    const text = ["## Decisions log", "- 2026-01-05: chose Stripe", "  more context", "## Open questions", "- something else"].join(
      "\n",
    );
    expect(parseDecisionsLog(text)).toEqual([{ date: "2026-01-05", text: "chose Stripe more context" }]);
  });

  it("tolerates markdown bold in the bullet text", () => {
    const text = `## Decisions log\n- 2026-01-05: **Decision:** chose Stripe\n`;
    expect(parseDecisionsLog(text)).toEqual([{ date: "2026-01-05", text: "**Decision:** chose Stripe" }]);
  });

  it("ignores a non-dated (template placeholder) bullet", () => {
    const text = `## Decisions log\n- {{YYYY-MM-DD}}: {{decision}}\n- 2026-01-05: real one\n`;
    expect(parseDecisionsLog(text)).toEqual([{ date: "2026-01-05", text: "real one" }]);
  });

  it("ignores a leading HTML-comment line before any bullet", () => {
    const text = `## Decisions log\n<!-- Resolved choices, with the reasoning. -->\n- 2026-01-05: real one\n`;
    expect(parseDecisionsLog(text)).toEqual([{ date: "2026-01-05", text: "real one" }]);
  });

  it("returns an empty array when there is no Decisions log section", () => {
    const text = `# State\n\n## Open questions\n- something\n`;
    expect(parseDecisionsLog(text)).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseDecisionsLog("")).toEqual([]);
  });
});

describe("buildChangelog: header and introduction", () => {
  it("emits the header and renders the oldest entry as an introduction (no diff)", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "abc1234", date: "2026-01-01", subject: "introduce model", diff: null }];
    const doc = buildChangelog(entries, [], opts("model.em", { slices: 1, elements: 2 }));
    expect(doc).toBe(
      [
        "# Model changelog — model.em",
        "## 2026-01-01 — introduce model (abc1234)",
        "Model introduced: 1 slice, 2 elements.",
      ].join("\n\n"),
    );
  });

  it("pluralizes slice/element counts correctly", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "abc1234", date: "2026-01-01", subject: "introduce model", diff: null }];
    const doc = buildChangelog(entries, [], opts("model.em", { slices: 3, elements: 7 }));
    expect(doc).toContain("Model introduced: 3 slices, 7 elements.");
  });

  it("renders an error note when the oldest revision itself fails to compile", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "abc1234", date: "2026-01-01", subject: "introduce model", diff: null }];
    const doc = buildChangelog(entries, [], { file: "model.em", intro: null, introError: "parse error: unexpected token" });
    expect(doc).toContain("_could not compile this revision: parse error: unexpected token_");
    expect(doc).not.toContain("Model introduced");
  });
});

describe("buildChangelog: newest-first ordering", () => {
  it("orders sections newest-first regardless of entries' oldest->newest input order", () => {
    const OLD = `slice "S" {\n  command A\n}`;
    const MID = `slice "S" {\n  command A\n}\nslice "T" {\n  command B\n}`;
    const NEW = `slice "S" {\n  command A\n}\nslice "T" {\n  command B\n}\nslice "U" {\n  command C\n}`;
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "second", diff: diffOf(OLD, MID) },
      { shortHash: "c3", date: "2026-01-03", subject: "third", diff: diffOf(MID, NEW) },
    ];
    const doc = buildChangelog(entries, [], opts());
    const headingOrder = [...doc.matchAll(/^## .+\(c\d\)$/gm)].map((m) => m[0]);
    expect(headingOrder).toEqual([
      "## 2026-01-03 — third (c3)",
      "## 2026-01-02 — second (c2)",
      "## 2026-01-01 — first (c1)",
    ]);
  });
});

describe("buildChangelog: skip-empty sections", () => {
  it("omits a non-intro section with no structural change and no matching decision", () => {
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "whitespace only", diff: NO_CHANGE_DIFF },
    ];
    const doc = buildChangelog(entries, [], opts());
    expect(doc).not.toContain("whitespace only");
  });

  it("keeps a no-structural-change section when a decision matches its date", () => {
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "comment tweak", diff: NO_CHANGE_DIFF },
    ];
    const decisions: DecisionEntry[] = [{ date: "2026-01-02", text: "clarified wording only, no model change" }];
    const doc = buildChangelog(entries, decisions, opts());
    expect(doc).toContain("comment tweak");
    expect(doc).toContain("no structural changes");
    expect(doc).toContain("Decisions:\n- clarified wording only, no model change");
  });

  it("always renders the introduction even with no changes to report (it has no diff to be empty)", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "c1", date: "2026-01-01", subject: "first", diff: null }];
    const doc = buildChangelog(entries, [], opts("model.em", { slices: 0, elements: 0 }));
    expect(doc).toContain("## 2026-01-01 — first (c1)");
  });
});

describe("buildChangelog: error sections", () => {
  it("renders a note (never throws) for a revision that failed to compile, and never omits it", () => {
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "broken revision", diff: null, error: "parse error: line 3" },
    ];
    const doc = buildChangelog(entries, [], opts());
    expect(doc).toContain("## 2026-01-02 — broken revision (c2)");
    expect(doc).toContain("_could not compile this revision: parse error: line 3_");
  });

  it("still attaches a matching decision to an error section", () => {
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "broken revision", diff: null, error: "parse error" },
    ];
    const decisions: DecisionEntry[] = [{ date: "2026-01-02", text: "attempted a syntax change, reverted" }];
    const doc = buildChangelog(entries, decisions, opts());
    expect(doc).toContain("Decisions:\n- attempted a syntax change, reverted");
  });
});

describe("buildChangelog: decisions weaving", () => {
  it("attaches a decision to the section sharing its date", () => {
    const OLD = `slice "S" {\n  command A\n}`;
    const NEW = `slice "S" {\n  command A\n}\nslice "T" {\n  command B\n}`;
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "add T", diff: diffOf(OLD, NEW) },
    ];
    const decisions: DecisionEntry[] = [{ date: "2026-01-02", text: "added slice T for fulfillment" }];
    const doc = buildChangelog(entries, decisions, opts());
    expect(doc).toContain("## 2026-01-02 — add T (c2)");
    expect(doc).toContain("Decisions:\n- added slice T for fulfillment");
  });

  it("attaches multiple decisions sharing a date to the same section, each as its own bullet", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "c1", date: "2026-01-01", subject: "first", diff: null }];
    const decisions: DecisionEntry[] = [
      { date: "2026-01-01", text: "decision A" },
      { date: "2026-01-01", text: "decision B" },
    ];
    const doc = buildChangelog(entries, decisions, opts());
    expect(doc).toContain("Decisions:\n- decision A\n- decision B");
  });

  it("attaches a date's decisions only to the NEWEST commit of that date — never duplicated per commit", () => {
    const OLD = `slice "S" {\n  command A\n}`;
    const MID = `slice "S" {\n  command A\n}\nslice "T" {\n  command B\n}`;
    const NEW = `${MID}\nslice "U" {\n  command C\n}`;
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "morning commit", diff: diffOf(OLD, MID) },
      { shortHash: "c3", date: "2026-01-02", subject: "evening commit", diff: diffOf(MID, NEW) },
    ];
    const decisions: DecisionEntry[] = [{ date: "2026-01-02", text: "the day's ruling" }];
    const doc = buildChangelog(entries, decisions, opts());
    // exactly one attachment, and it's in the newest same-date section
    expect(doc.match(/the day's ruling/g)).toHaveLength(1);
    const evening = doc.indexOf("evening commit");
    const morning = doc.indexOf("morning commit");
    const ruling = doc.indexOf("the day's ruling");
    expect(evening).toBeGreaterThanOrEqual(0);
    expect(ruling).toBeGreaterThan(evening);
    expect(ruling).toBeLessThan(morning); // newest-first: evening section precedes morning
  });

  it("routes an unmatched decision (no commit on that date) to the trailing section, dropping nothing", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "c1", date: "2026-01-01", subject: "first", diff: null }];
    const decisions: DecisionEntry[] = [
      { date: "2026-01-01", text: "matched decision" },
      { date: "2025-12-25", text: "orphan decision, predates the model" },
    ];
    const doc = buildChangelog(entries, decisions, opts());
    expect(doc).toContain("Decisions:\n- matched decision");
    expect(doc).toContain("## Decisions not tied to a model commit\n\n- 2025-12-25: orphan decision, predates the model");
  });

  it("omits the trailing section entirely when every decision matched", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "c1", date: "2026-01-01", subject: "first", diff: null }];
    const decisions: DecisionEntry[] = [{ date: "2026-01-01", text: "matched decision" }];
    const doc = buildChangelog(entries, decisions, opts());
    expect(doc).not.toContain("Decisions not tied to a model commit");
  });

  it("gracefully produces no Decisions block anywhere when there are no decisions at all", () => {
    const entries: ChangelogEntry[] = [{ shortHash: "c1", date: "2026-01-01", subject: "first", diff: null }];
    const doc = buildChangelog(entries, [], opts());
    expect(doc).not.toContain("Decisions");
  });
});

describe("buildChangelog: diff body reuses the diff formatter's rollup + per-change lines", () => {
  it("embeds formatModelDiff's summary line and per-change lines verbatim", () => {
    const OLD = `slice "S" {\n  command A\n}`;
    const NEW = `slice "S" {\n  command A\n}\nslice "T" {\n  command B\n}`;
    const diff = diffOf(OLD, NEW);
    const entries: ChangelogEntry[] = [
      { shortHash: "c1", date: "2026-01-01", subject: "first", diff: null },
      { shortHash: "c2", date: "2026-01-02", subject: "add T", diff },
    ];
    const doc = buildChangelog(entries, [], opts());
    expect(doc).toContain("1 slice added");
    expect(doc).toContain('+ slice "T"');
  });
});
