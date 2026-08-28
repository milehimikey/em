// SPDX-License-Identifier: MIT
// Coverage for `em state log-usage` / `em usage-report`'s pure logic (src/cli/usageLog.ts,
// MIL-161): the Usage log section locator/writer, the canonical-line parser (including the
// malformed-line escape hatch), phase sorting/validation, and report aggregation. CLI-level
// exit-code/process coverage (argument wiring, --phases validation errors, directory walking,
// --json) lives in test/cli.test.ts.
import { describe, it, expect } from "vitest";
import {
  USAGE_PHASES,
  isUsagePhase,
  sortUsagePhases,
  appendUsageLogEntry,
  formatUsageLogLine,
  parseUsageLogSection,
  aggregateUsageReport,
  formatUsageReportText,
} from "../src/cli/usageLog.js";

const STATE_TEMPLATE_SNIPPET =
  "# Event Modeling Progress — Demo\n" +
  "\n" +
  "- **Model file:** `demo.em`\n" +
  "\n" +
  "## Decisions log\n" +
  "- 2026-08-01: some decision — why\n" +
  "\n" +
  "## Usage log\n" +
  "<!-- The team's only usage signal today (see docs/usage-data.md) — cheap and coarse on purpose.\n" +
  "     One line per session. -->\n" +
  "\n" +
  "## Open questions / parking lot\n" +
  "- [ ] a question\n";

describe("USAGE_PHASES / isUsagePhase", () => {
  it("is the state phase enum plus watch, in that order", () => {
    expect(USAGE_PHASES).toEqual(["discover", "extract", "model", "slice", "implement", "conform", "review", "validate", "watch"]);
  });

  it("accepts every phase, including watch", () => {
    for (const p of USAGE_PHASES) expect(isUsagePhase(p)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUsagePhase("bogus")).toBe(false);
    expect(isUsagePhase("")).toBe(false);
  });
});

describe("sortUsagePhases", () => {
  it("dedupes and sorts into USAGE_PHASES' own canonical order, not input order", () => {
    expect(sortUsagePhases(["slice", "model", "slice", "discover"])).toEqual(["discover", "model", "slice"]);
  });

  it("sorts watch after validate", () => {
    expect(sortUsagePhases(["watch", "discover"])).toEqual(["discover", "watch"]);
  });
});

describe("formatUsageLogLine", () => {
  it("formats the exact canonical shape", () => {
    expect(formatUsageLogLine("2026-08-28", ["model", "slice"], ["none"])).toBe(
      "- 2026-08-28: phases: model, slice — validate: none",
    );
  });
});

describe("appendUsageLogEntry", () => {
  it("appends the first entry right after the guidance comment, before the next heading", () => {
    const result = appendUsageLogEntry(STATE_TEMPLATE_SNIPPET, "2026-08-28", ["model"], ["none"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(
      "on purpose.\n     One line per session. -->\n- 2026-08-28: phases: model — validate: none\n\n## Open questions",
    );
  });

  it("appends a second entry after the first, never editing it", () => {
    const first = appendUsageLogEntry(STATE_TEMPLATE_SNIPPET, "2026-08-28", ["model"], ["none"]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendUsageLogEntry(first.text, "2026-08-29", ["slice"], ["read model has no consumer"]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toContain(
      "- 2026-08-28: phases: model — validate: none\n- 2026-08-29: phases: slice — validate: read model has no consumer\n\n## Open questions",
    );
  });

  it("leaves every other section byte-identical", () => {
    const result = appendUsageLogEntry(STATE_TEMPLATE_SNIPPET, "2026-08-28", ["model"], ["none"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith("# Event Modeling Progress — Demo\n\n- **Model file:** `demo.em`\n\n## Decisions log\n- 2026-08-01: some decision — why\n\n## Usage log\n")).toBe(true);
    expect(result.text.endsWith("## Open questions / parking lot\n- [ ] a question\n")).toBe(true);
  });

  it("refuses when there's no Usage log heading at all", () => {
    const result = appendUsageLogEntry("# Just a heading\n\nbody\n", "2026-08-28", ["model"], ["none"]);
    expect(result).toEqual({ ok: false, message: 'missing "## Usage log" section' });
  });

  it("works when the Usage log section is the very last thing in the file", () => {
    const trailing = "## Usage log\n<!-- comment -->\n";
    const result = appendUsageLogEntry(trailing, "2026-08-28", ["model"], ["none"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("## Usage log\n<!-- comment -->\n- 2026-08-28: phases: model — validate: none\n");
  });
});

describe("parseUsageLogSection", () => {
  it("parses zero entries from a freshly-scaffolded (empty) section", () => {
    const result = parseUsageLogSection(STATE_TEMPLATE_SNIPPET);
    expect(result).toEqual({ entries: [], malformed: [] });
  });

  it("parses multiple canonical entries, splitting phases/categories on comma", () => {
    const withEntries =
      "## Usage log\n<!-- comment -->\n" +
      "- 2026-08-01: phases: discover, model — validate: none\n" +
      "- 2026-08-02: phases: slice — validate: read model has no consumer, command nothing triggers\n" +
      "\n## Open questions\n";
    const result = parseUsageLogSection(withEntries);
    expect(result.malformed).toEqual([]);
    expect(result.entries).toEqual([
      { date: "2026-08-01", phases: ["discover", "model"], categories: ["none"] },
      { date: "2026-08-02", phases: ["slice"], categories: ["read model has no consumer", "command nothing triggers"] },
    ]);
  });

  it("reports a non-canonical bullet as malformed rather than dropping or force-parsing it", () => {
    const withLegacyLine =
      "## Usage log\n<!-- comment -->\n" +
      "- 2025-01-01: touched model phase, no issues\n" +
      "\n## Open questions\n";
    const result = parseUsageLogSection(withLegacyLine);
    expect(result.entries).toEqual([]);
    expect(result.malformed).toEqual(["- 2025-01-01: touched model phase, no issues"]);
  });

  it("ignores blank lines and the guidance comment, only flagging actual '- ' bullets", () => {
    const result = parseUsageLogSection(STATE_TEMPLATE_SNIPPET);
    expect(result.malformed).toEqual([]);
  });

  it("returns empty when there's no Usage log heading at all", () => {
    expect(parseUsageLogSection("# nothing here\n")).toEqual({ entries: [], malformed: [] });
  });

  it("round-trips through appendUsageLogEntry", () => {
    const first = appendUsageLogEntry(STATE_TEMPLATE_SNIPPET, "2026-08-28", ["model", "slice"], ["none"]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const result = parseUsageLogSection(first.text);
    expect(result).toEqual({
      entries: [{ date: "2026-08-28", phases: ["model", "slice"], categories: ["none"] }],
      malformed: [],
    });
  });
});

describe("aggregateUsageReport", () => {
  it("tallies phases and categories across multiple files, excluding 'none' from category counts", () => {
    const fileA =
      "## Usage log\n<!-- c -->\n- 2026-08-01: phases: discover, model — validate: none\n\n## Open questions\n";
    const fileB =
      "## Usage log\n<!-- c -->\n" +
      "- 2026-08-02: phases: model, slice — validate: read model has no consumer\n" +
      "- 2026-08-03: phases: slice — validate: read model has no consumer, command nothing triggers\n" +
      "\n## Open questions\n";
    const report = aggregateUsageReport(".", [
      { file: "a/.event-modeling.md", text: fileA },
      { file: "b/.event-modeling.md", text: fileB },
    ]);
    expect(report.sessions).toBe(3);
    expect(report.files).toEqual(["a/.event-modeling.md", "b/.event-modeling.md"]);
    expect(report.phaseCounts).toEqual([
      { key: "model", count: 2 },
      { key: "slice", count: 2 },
      { key: "discover", count: 1 },
    ]);
    expect(report.categoryCounts).toEqual([
      { key: "read model has no consumer", count: 2 },
      { key: "command nothing triggers", count: 1 },
    ]);
    expect(report.unparseableLines).toEqual([]);
  });

  it("surfaces malformed lines per-file rather than silently dropping them", () => {
    const fileA = "## Usage log\n<!-- c -->\n- weird line, not canonical\n\n## Open questions\n";
    const report = aggregateUsageReport(".", [{ file: "a/.event-modeling.md", text: fileA }]);
    expect(report.sessions).toBe(0);
    expect(report.unparseableLines).toEqual([{ file: "a/.event-modeling.md", line: "- weird line, not canonical" }]);
  });

  it("ties in count are broken alphabetically", () => {
    const fileA =
      "## Usage log\n<!-- c -->\n" +
      "- 2026-08-01: phases: slice — validate: none\n" +
      "- 2026-08-02: phases: discover — validate: none\n" +
      "\n## Open questions\n";
    const report = aggregateUsageReport(".", [{ file: "a/.event-modeling.md", text: fileA }]);
    expect(report.phaseCounts).toEqual([
      { key: "discover", count: 1 },
      { key: "slice", count: 1 },
    ]);
  });

  it("handles zero input files", () => {
    const report = aggregateUsageReport(".", []);
    expect(report).toEqual({
      root: ".",
      files: [],
      sessions: 0,
      phaseCounts: [],
      categoryCounts: [],
      unparseableLines: [],
    });
  });
});

describe("formatUsageReportText", () => {
  it("renders an empty-aware summary with no entries", () => {
    const report = aggregateUsageReport(".", []);
    const text = formatUsageReportText(report);
    expect(text).toContain("0 state file(s) under ., 0 logged session(s)");
    expect(text).toContain("(none logged)");
  });

  it("renders counts and unparseable lines when present", () => {
    const fileA =
      "## Usage log\n<!-- c -->\n" +
      "- 2026-08-01: phases: model — validate: none\n" +
      "- weird line\n" +
      "\n## Open questions\n";
    const report = aggregateUsageReport(".", [{ file: "a/.event-modeling.md", text: fileA }]);
    const text = formatUsageReportText(report);
    expect(text).toContain("1 state file(s) under ., 1 logged session(s)");
    expect(text).toContain("model");
    expect(text).toContain("didn't match the canonical format");
    expect(text).toContain("a/.event-modeling.md: - weird line");
  });
});
