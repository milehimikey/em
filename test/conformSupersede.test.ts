// SPDX-License-Identifier: MIT
// Coverage for `em conform-supersede` (src/cli/conformSupersede.ts, MIL-164): the pure banner
// splice (`applySupersededBanner`) and the fs orchestration (`runConformSupersede`). Mirrors
// test/ratify.test.ts's structure — additive-splice discipline, idempotency, accumulation.
// CLI-level exit-code/process coverage (argument wiring, --on validation) lives in
// test/cli.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySupersededBanner, runConformSupersede } from "../src/cli/conformSupersede.js";

const REPORT = `# Conformance Report — Meridian Goods — 2026-08-23

- **Model:** \`meridian-goods.em\`
- **Target repo:** . @ \`8f12ed8\`

## Summary

Clean.
`;

describe("applySupersededBanner (pure text surgery)", () => {
  it("inserts one banner line directly under the title, leaving everything else byte-identical", () => {
    const result = applySupersededBanner(REPORT, "a1b2c3d", "1-3", "2026-08-27");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const lines = result.content.split("\n");
    expect(lines[0]).toBe("# Conformance Report — Meridian Goods — 2026-08-23");
    expect(lines[1]).toBe(
      "> **Superseded as of `a1b2c3d`** — findings 1-3 since ruled (2026-08-27). This report describes an ancestor of the current model; verify file:line citations against the current code before relying on them.",
    );
    // Everything after the title, minus the inserted line, is byte-identical to the original.
    const originalRest = REPORT.slice(REPORT.indexOf("\n") + 1);
    const newRest = result.content.slice(result.content.indexOf("\n", result.content.indexOf("\n") + 1) + 1);
    expect(newRest).toBe(originalRest);
  });

  it("is idempotent: re-applying the exact same stamp is a no-op with byte-identical content", () => {
    const first = applySupersededBanner(REPORT, "a1b2c3d", "1-3", "2026-08-27");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applySupersededBanner(first.content, "a1b2c3d", "1-3", "2026-08-27");
    expect(second).toEqual({ ok: true, content: first.content, changed: false });
  });

  it("accumulates a second, distinct stamp rather than overwriting the first", () => {
    const first = applySupersededBanner(REPORT, "a1b2c3d", "1-3", "2026-08-27");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applySupersededBanner(first.content, "e4f5a6b", "4", "2026-09-02");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(true);
    const lines = second.content.split("\n");
    expect(lines[0]).toBe("# Conformance Report — Meridian Goods — 2026-08-23");
    expect(lines[1]).toContain("Superseded as of `a1b2c3d`");
    expect(lines[1]).toContain("findings 1-3");
    expect(lines[2]).toContain("Superseded as of `e4f5a6b`");
    expect(lines[2]).toContain("findings 4");
    // Exactly one blank line separates the accumulated banner block from the rest.
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("- **Model:** `meridian-goods.em`");
  });

  it("preserves CRLF line endings when the report already uses them", () => {
    const crlfReport = REPORT.replace(/\n/g, "\r\n");
    const result = applySupersededBanner(crlfReport, "a1b2c3d", "1-3", "2026-08-27");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("\r\n> **Superseded");
    expect(result.content).not.toMatch(/[^\r]\n/); // every \n is preceded by \r
  });

  it("refuses when the report has no title line to anchor under", () => {
    const result = applySupersededBanner("", "a1b2c3d", "1-3", "2026-08-27");
    expect(result).toEqual({ ok: false, message: "report has no title line to anchor the banner after" });
  });

  it("refuses an empty --as-of", () => {
    const result = applySupersededBanner(REPORT, "  ", "1-3", "2026-08-27");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("a revision is required");
  });

  it("refuses a revision containing a backtick (would break the inline code span)", () => {
    const result = applySupersededBanner(REPORT, "a1b`2c3d", "1-3", "2026-08-27");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("control characters or a backtick");
  });

  it("refuses a control character in the revision", () => {
    const result = applySupersededBanner(REPORT, "a1b2\nc3d", "1-3", "2026-08-27");
    expect(result.ok).toBe(false);
  });

  it("refuses an empty --findings", () => {
    const result = applySupersededBanner(REPORT, "a1b2c3d", "", "2026-08-27");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("a findings spec is required");
  });

  it("refuses a --findings value carrying anything other than digits/commas/spaces/dashes", () => {
    const result = applySupersededBanner(REPORT, "a1b2c3d", "1-3; DROP TABLE", "2026-08-27");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('must be a plain list/range of numbers');
  });

  it("accepts a comma-separated --findings list and an en-dash range", () => {
    const commaResult = applySupersededBanner(REPORT, "a1b2c3d", "1, 2, 4", "2026-08-27");
    expect(commaResult.ok).toBe(true);
    const dashResult = applySupersededBanner(REPORT, "a1b2c3d", "1–3", "2026-08-27");
    expect(dashResult.ok).toBe(true);
  });

  it("refuses a malformed --on date", () => {
    const result = applySupersededBanner(REPORT, "a1b2c3d", "1-3", "not-a-date");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('invalid date "not-a-date"');
  });
});

describe("runConformSupersede (real fs)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-conform-supersede-"));
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(join(dir, "conformance", "2026-08-23-report.md"), REPORT);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stamps the report on disk and reports changed: true", () => {
    const result = runConformSupersede(dir, "conformance/2026-08-23-report.md", "a1b2c3d", "1-3", "2026-08-27");
    expect(result).toEqual({ ok: true, path: "conformance/2026-08-23-report.md", changed: true, findingsRuling: { kind: "not-requested" } });
    const onDisk = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    expect(onDisk).toContain("Superseded as of `a1b2c3d`");
  });

  it("re-running the identical stamp is a no-op (changed: false), file untouched", () => {
    const before = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    const result = runConformSupersede(dir, "conformance/2026-08-23-report.md", "a1b2c3d", "1-3", "2026-08-27");
    expect(result).toEqual({ ok: true, path: "conformance/2026-08-23-report.md", changed: false, findingsRuling: { kind: "not-requested" } });
    const after = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    expect(after).toBe(before);
  });

  it("refuses cleanly when the report doesn't exist, without creating one", () => {
    const result = runConformSupersede(dir, "conformance/no-such-report.md", "a1b2c3d", "1-3", "2026-08-27");
    expect(result).toEqual({ ok: false, message: "no such report: conformance/no-such-report.md" });
  });

  it("prefixes a pure-validation failure message with the report path", () => {
    const result = runConformSupersede(dir, "conformance/2026-08-23-report.md", "", "1-3", "2026-08-27");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("conformance/2026-08-23-report.md: a revision is required (--as-of)");
  });
});

describe("runConformSupersede — --locus/--by findings ruling (MIL-214)", () => {
  let dir: string;
  const OTHER_REPORT = `# Conformance Report — Neutral — 2026-09-01\n\nClean.\n`;
  const FINDINGS_PATH = "conformance/2026-09-01-findings.json";
  const NO_FINDINGS_REPORT_PATH = "conformance/2026-08-23-report.md"; // no sibling findings.json

  function findingsDoc() {
    return {
      findingsSchemaVersion: "1.0",
      model: "neutral.em",
      report: "conformance/2026-09-01-report.md",
      revision: "8f12ed8",
      findings: [
        { id: 1, surface: "structural", class: "Real drift", slice: "checkout", evidence: "code shows X", locus: null, resolvedBy: null, resolvedOn: null },
        { id: 2, surface: "spec", class: "Model gap", slice: null, evidence: "no doc claim", locus: null, resolvedBy: null, resolvedOn: null },
      ],
    };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-conform-supersede-ruling-"));
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(join(dir, NO_FINDINGS_REPORT_PATH), REPORT);
    writeFileSync(join(dir, "conformance", "2026-09-01-report.md"), OTHER_REPORT);
    writeFileSync(join(dir, FINDINGS_PATH), JSON.stringify(findingsDoc(), null, 2) + "\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("records the ruling on the named findings and still stamps the banner", () => {
    const result = runConformSupersede(dir, "conformance/2026-09-01-report.md", "8f12ed8", "1", "2026-09-02", {
      locus: "code",
      by: "Alex Rivera",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.findingsRuling).toEqual({ kind: "applied", path: FINDINGS_PATH, changed: true, ids: [1] });
    const onDisk = JSON.parse(readFileSync(join(dir, FINDINGS_PATH), "utf8"));
    expect(onDisk.findings.find((f: { id: number }) => f.id === 1)).toEqual({
      id: 1,
      surface: "structural",
      class: "Real drift",
      slice: "checkout",
      evidence: "code shows X",
      locus: "code",
      resolvedBy: "Alex Rivera",
      resolvedOn: "2026-09-02",
    });
    // Finding 2 is untouched — only the named id(s) are ruled.
    expect(onDisk.findings.find((f: { id: number }) => f.id === 2).locus).toBeNull();
    const report = readFileSync(join(dir, "conformance", "2026-09-01-report.md"), "utf8");
    expect(report).toContain("Superseded as of `8f12ed8`");
  });

  it("is idempotent on the exact same ruling (changed: false)", () => {
    const before = readFileSync(join(dir, FINDINGS_PATH), "utf8");
    const result = runConformSupersede(dir, "conformance/2026-09-01-report.md", "8f12ed8", "1", "2026-09-02", {
      locus: "code",
      by: "Alex Rivera",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findingsRuling).toEqual({ kind: "applied", path: FINDINGS_PATH, changed: false, ids: [1] });
    expect(readFileSync(join(dir, FINDINGS_PATH), "utf8")).toBe(before);
  });

  it("refuses to overwrite an already-different locus on a named finding", () => {
    const before = readFileSync(join(dir, FINDINGS_PATH), "utf8");
    const result = runConformSupersede(dir, "conformance/2026-09-01-report.md", "8f12ed8", "1", "2026-09-03", {
      locus: "doc",
      by: "Jordan Lee",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('finding 1 already has locus "code"');
    expect(readFileSync(join(dir, FINDINGS_PATH), "utf8")).toBe(before); // no partial write
  });

  it("refuses when a named finding id doesn't exist in the record", () => {
    const result = runConformSupersede(dir, "conformance/2026-09-01-report.md", "8f12ed8", "99", "2026-09-03", {
      locus: "none",
      by: "Jordan Lee",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no finding(s) with id 99");
  });

  it("warns (no-findings-file) and still stamps the banner when no findings JSON exists beside the report", () => {
    const result = runConformSupersede(dir, NO_FINDINGS_REPORT_PATH, "a1b2c3d", "1-3", "2026-09-04", {
      locus: "code",
      by: "Alex Rivera",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findingsRuling.kind).toBe("no-findings-file");
    if (result.findingsRuling.kind === "no-findings-file") {
      expect(result.findingsRuling.warning).toContain("no findings JSON found beside");
    }
    const onDisk = readFileSync(join(dir, NO_FINDINGS_REPORT_PATH), "utf8");
    expect(onDisk).toContain("Superseded as of `a1b2c3d`");
  });

  it("refuses a --findings spec that doesn't parse into ids when a ruling is requested", () => {
    const result = runConformSupersede(dir, "conformance/2026-09-01-report.md", "8f12ed8", "3-1", "2026-09-05", {
      locus: "none",
      by: "Alex Rivera",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('doesn\'t parse into finding id(s)');
  });
});
