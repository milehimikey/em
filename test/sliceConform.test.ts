// SPDX-License-Identifier: MIT
// Coverage for `em slice conform` (src/cli/sliceConform.ts, MIL-214): the pure frontmatter
// text-surgery (`applyConformFrontmatter`), the findings-file lookup (`findLatestFindingsForRevision`),
// and the note-binding resolution + fs orchestration (`runSliceConform`). Mirrors
// test/ratify.test.ts's structure. CLI-level exit-code/process coverage lives in
// test/cli.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { applyConformFrontmatter, findLatestFindingsForRevision, runSliceConform } from "../src/cli/sliceConform.js";
import { serializeFindingsDoc } from "../src/cli/findings.js";

const IMPLEMENTED_DOC =
  "---\n" +
  "schemaVersion: 1\n" +
  "pattern: state-change\n" +
  "swimlane: order\n" +
  "status: implemented\n" +
  "version: 2\n" +
  "implementedIn: https://github.com/org/repo/pull/9\n" +
  "---\n" +
  "# Slice: Shipped Slice\n" +
  "\n" +
  "Some body prose that must survive byte-for-byte.\n";

const DRAFT_DOC =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n";

const NO_LINK_DOC =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\n---\nbody\n";

describe("applyConformFrontmatter (pure text surgery)", () => {
  it("inserts conformedVersion/conformedAt/conformedOn fresh, right after implementedIn", () => {
    const result = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.version).toBe(2);
    expect(result.content).toContain(
      "implementedIn: https://github.com/org/repo/pull/9\nconformedVersion: 2\nconformedAt: 8f12ed8\nconformedOn: 2026-09-08\n",
    );
    expect(result.content).toContain("status: implemented"); // untouched
    expect(result.content).toContain("version: 2"); // untouched, and NOT bumped
    const bodyMarker = "# Slice: Shipped Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      IMPLEMENTED_DOC.slice(IMPLEMENTED_DOC.indexOf(bodyMarker)),
    );
  });

  it("is idempotent on the same (conformedVersion, conformedAt) pair — conformedOn untouched even if a different --on is passed", () => {
    const first = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "8f12ed8", "2026-09-08");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyConformFrontmatter(first.content, "shipped-slice", "8f12ed8", "2026-09-09");
    expect(second).toEqual({ ok: true, content: first.content, changed: false, version: 2 });
  });

  it("OVERWRITES (never refuses) when --at names a different revision for the same version", () => {
    const first = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "8f12ed8", "2026-09-08");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyConformFrontmatter(first.content, "shipped-slice", "aaaaaaa", "2026-09-15");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(true);
    expect(second.content).toContain("conformedAt: aaaaaaa");
    expect(second.content).toContain("conformedOn: 2026-09-15");
    expect(second.content).not.toContain("conformedAt: 8f12ed8");
  });

  it("replaces an existing triple in place rather than duplicating the keys", () => {
    const first = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "8f12ed8", "2026-09-08");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyConformFrontmatter(first.content, "shipped-slice", "bbbbbbb", "2026-09-16");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.content.match(/conformedVersion:/g)?.length).toBe(1);
    expect(second.content.match(/conformedAt:/g)?.length).toBe(1);
    expect(second.content.match(/conformedOn:/g)?.length).toBe(1);
  });

  it("refuses a doc that isn't status: implemented", () => {
    const result = applyConformFrontmatter(DRAFT_DOC, "draft-slice", "8f12ed8", "2026-09-08");
    expect(result).toEqual({
      ok: false,
      message:
        'slice "draft-slice" is `status: draft` — only a slice at `status: implemented` can be certified; ' +
        "run `em slice mark-implemented` first",
    });
  });

  it("refuses an implemented doc with no implementedIn link", () => {
    const result = applyConformFrontmatter(NO_LINK_DOC, "no-link-slice", "8f12ed8", "2026-09-08");
    expect(result).toEqual({
      ok: false,
      message: 'slice "no-link-slice" has `status: implemented` but no `implementedIn:` link — nothing to certify against',
    });
  });

  it("refuses a blank --at", () => {
    const result = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "   ", "2026-09-08");
    expect(result).toEqual({ ok: false, message: "a target-repo revision is required (--at)" });
  });

  it("refuses a --at value with whitespace", () => {
    const result = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "8f1 2ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("must not contain control characters or whitespace");
  });

  it("refuses a malformed --on date", () => {
    const result = applyConformFrontmatter(IMPLEMENTED_DOC, "shipped-slice", "8f12ed8", "not-a-date");
    expect(result).toEqual({ ok: false, message: 'invalid date "not-a-date" — expected YYYY-MM-DD' });
  });

  it("refuses with a clear error when there is no frontmatter block", () => {
    const result = applyConformFrontmatter("# Just a heading\n\nbody\n", "x", "8f12ed8", "2026-09-08");
    expect(result).toEqual({ ok: false, message: "no frontmatter block found" });
  });

  it("keeps the file's own line-ending style for inserted lines (CRLF)", () => {
    const crlf = IMPLEMENTED_DOC.replace(/\n/g, "\r\n");
    const result = applyConformFrontmatter(crlf, "shipped-slice", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(
      "implementedIn: https://github.com/org/repo/pull/9\r\nconformedVersion: 2\r\nconformedAt: 8f12ed8\r\nconformedOn: 2026-09-08\r\n",
    );
  });

  it("refuses when version: isn't a positive integer", () => {
    const bad = IMPLEMENTED_DOC.replace("version: 2", "version: not-a-number");
    const result = applyConformFrontmatter(bad, "shipped-slice", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("isn't a positive integer");
  });
});

describe("findLatestFindingsForRevision (real fs)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slice-conform-findings-"));
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(
      join(dir, "conformance", "2026-08-15-findings.json"),
      serializeFindingsDoc({
        findingsSchemaVersion: "1.0",
        model: "model.em",
        report: "conformance/2026-08-15-report.md",
        revision: "8f12ed8",
        findings: [],
      }),
    );
    writeFileSync(
      join(dir, "conformance", "2026-09-01-findings.json"),
      serializeFindingsDoc({
        findingsSchemaVersion: "1.0",
        model: "model.em",
        report: "conformance/2026-09-01-report.md",
        revision: "8f12ed8",
        findings: [
          { id: 1, surface: "structural", class: "Real drift", slice: "checkout", evidence: "e1", locus: null, resolvedBy: null, resolvedOn: null },
        ],
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("picks the NEWEST (by filename) findings file matching the revision", () => {
    const found = findLatestFindingsForRevision(dir, "8f12ed8");
    expect(found?.path).toBe("conformance/2026-09-01-findings.json");
    expect(found?.doc.findings).toHaveLength(1);
  });

  it("returns null when no findings file matches the revision", () => {
    expect(findLatestFindingsForRevision(dir, "no-such-rev")).toBeNull();
  });

  it("returns null when conformance/ doesn't exist", () => {
    const empty = mkdtempSync(join(tmpdir(), "em-slice-conform-empty-"));
    try {
      expect(findLatestFindingsForRevision(empty, "8f12ed8")).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("runSliceConform (note-binding resolution + fs orchestration)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slice-conform-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "shipped-slice.md"), IMPLEMENTED_DOC);
    writeFileSync(
      join(dir, "shipped.em"),
      'slice "Shipped Slice" {\n  command Do Thing note "slices/shipped-slice.md"\n  event Thing Done\n}\n',
    );
    writeFileSync(join(dir, "unbound.em"), 'slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n');
    writeFileSync(
      join(dir, "ghost.em"),
      'slice "Ghost" {\n  command Do Thing note "slices/ghost.md"\n  event Thing Done\n}\n',
    );
    writeFileSync(join(dir, "slices", "invalid.md"), "# No Frontmatter\n\nbody\n");
    writeFileSync(
      join(dir, "invalid.em"),
      'slice "Invalid" {\n  command Do Thing note "slices/invalid.md"\n  event Thing Done\n}\n',
    );
    writeFileSync(join(dir, "slices", "draft-slice.md"), DRAFT_DOC);
    writeFileSync(
      join(dir, "draft.em"),
      'slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n  event Thing Done\n}\n',
    );

    // Findings-check gate fixtures.
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(join(dir, "slices", "gated-slice.md"), IMPLEMENTED_DOC.replace("version: 2", "version: 2"));
    writeFileSync(
      join(dir, "gated.em"),
      'slice "Gated Slice" {\n  command Do Thing note "slices/gated-slice.md"\n  event Thing Done\n}\n',
    );
    writeFileSync(
      join(dir, "conformance", "2026-09-01-findings.json"),
      serializeFindingsDoc({
        findingsSchemaVersion: "1.0",
        model: "gated.em",
        report: "conformance/2026-09-01-report.md",
        revision: "8f12ed8",
        findings: [
          { id: 1, surface: "structural", class: "Real drift", slice: "gated-slice", evidence: "e1", locus: null, resolvedBy: null, resolvedOn: null },
        ],
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(file: string, sliceKey: string, at: string, on: string, skipFindingsCheck = false) {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runSliceConform(model, refs, dir, sliceKey, at, on, skipFindingsCheck);
  }

  it("certifies a note-bound doc and writes it to disk", () => {
    const result = run("shipped.em", "shipped-slice", "8f12ed8", "2026-09-08");
    expect(result).toEqual({ ok: true, path: "slices/shipped-slice.md", changed: true, version: 2, skippedFindingsCheck: null });
    const written = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    expect(written).toContain("conformedVersion: 2");
    expect(written).toContain("conformedAt: 8f12ed8");
    expect(written).toContain("conformedOn: 2026-09-08");
  });

  it("is idempotent on a second run with the same --at", () => {
    const before = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    const result = run("shipped.em", "shipped-slice", "8f12ed8", "2026-09-08");
    expect(result).toEqual({ ok: true, path: "slices/shipped-slice.md", changed: false, version: 2, skippedFindingsCheck: null });
    expect(readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8")).toBe(before);
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const result = run("shipped.em", "no-such-key", "8f12ed8", "2026-09-08");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });

  it("errors clearly when no doc is bound via note", () => {
    const result = run("unbound.em", "unbound", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("errors clearly when the bound note names a file that doesn't exist", () => {
    const result = run("ghost.em", "ghost", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no such file exists");
  });

  it("errors clearly when the bound doc has no usable frontmatter", () => {
    const result = run("invalid.em", "invalid", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("invalid frontmatter");
  });

  it("refuses a draft doc, prefixed with the doc path", () => {
    const result = run("draft.em", "draft-slice", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'slices/draft-slice.md: slice "draft-slice" is `status: draft` — only a slice at `status: implemented` ' +
        "can be certified; run `em slice mark-implemented` first",
    );
  });

  it("refuses when the findings-check gate finds an unruled finding in scope at this revision", () => {
    const result = run("gated.em", "gated-slice", "8f12ed8", "2026-09-08");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("1 unruled conformance finding(s)");
    expect(result.message).toContain("--skip-findings-check");
  });

  it("--skip-findings-check certifies anyway and reports the skipped finding ids", () => {
    const result = run("gated.em", "gated-slice", "8f12ed8", "2026-09-09", true);
    expect(result).toEqual({
      ok: true,
      path: "slices/gated-slice.md",
      changed: true,
      version: 2,
      skippedFindingsCheck: [1],
    });
    const written = readFileSync(join(dir, "slices", "gated-slice.md"), "utf8");
    expect(written).toContain("conformedVersion: 2");
  });

  it("a different --at (no matching findings file for that revision) is never gated", () => {
    // Fresh doc so this is a first-ever certify at a revision no findings file names.
    writeFileSync(join(dir, "slices", "ungated-slice.md"), IMPLEMENTED_DOC);
    writeFileSync(
      join(dir, "ungated.em"),
      'slice "Ungated Slice" {\n  command Do Thing note "slices/ungated-slice.md"\n  event Thing Done\n}\n',
    );
    const result = run("ungated.em", "ungated-slice", "zzzzzzz", "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skippedFindingsCheck).toBeNull();
  });
});
