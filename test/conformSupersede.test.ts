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
    expect(result).toEqual({ ok: true, path: "conformance/2026-08-23-report.md", changed: true });
    const onDisk = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    expect(onDisk).toContain("Superseded as of `a1b2c3d`");
  });

  it("re-running the identical stamp is a no-op (changed: false), file untouched", () => {
    const before = readFileSync(join(dir, "conformance", "2026-08-23-report.md"), "utf8");
    const result = runConformSupersede(dir, "conformance/2026-08-23-report.md", "a1b2c3d", "1-3", "2026-08-27");
    expect(result).toEqual({ ok: true, path: "conformance/2026-08-23-report.md", changed: false });
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
