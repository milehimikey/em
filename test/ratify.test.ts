// SPDX-License-Identifier: MIT
// Coverage for `em slice ratify` (src/cli/ratify.ts, MIL-165): the pure frontmatter text-surgery
// (`applyRatifyFrontmatter`) and the note-binding resolution + fs orchestration (`runRatify`).
// Mirrors test/markImplemented.test.ts's structure and idempotency-discipline coverage — the two
// commands share the same shape. CLI-level exit-code/process coverage (argument wiring, error-
// scoping to the named slice, --on validation) lives in test/cli.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { applyRatifyFrontmatter, runRatify } from "../src/cli/ratify.js";

const DRAFT_DOC =
  "---\n" +
  "schemaVersion: 1\n" +
  "pattern: state-change\n" +
  "swimlane: order\n" +
  "status: draft\n" +
  "version: 1\n" +
  "---\n" +
  "# Slice: Draft Slice\n" +
  "\n" +
  "## Intent\n" +
  "\n" +
  "Some body prose that must survive byte-for-byte.\n";

describe("applyRatifyFrontmatter (pure text surgery)", () => {
  it("flips status and adds fresh ratifiedBy/ratifiedOn lines, leaving version/body untouched", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedOn: 2026-08-28");
    expect(result.content).toContain("version: 1"); // untouched
    const bodyMarker = "# Slice: Draft Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      DRAFT_DOC.slice(DRAFT_DOC.indexOf(bodyMarker)),
    );
  });

  it("is idempotent: re-applying the same by/on pair is a no-op with byte-identical content", () => {
    const first = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "2026-08-28");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRatifyFrontmatter(first.content, "Alex Rivera", "2026-08-28");
    expect(second).toEqual({ ok: true, content: first.content, changed: false });
  });

  it("refuses to overwrite a different ratifier once already ready-to-implement, without mutating content", () => {
    const first = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "2026-08-28");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRatifyFrontmatter(first.content, "Jordan Lee", "2026-08-28");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("already ratified by Alex Rivera on 2026-08-28");
    expect(second.message).toContain("Jordan Lee on 2026-08-28");
  });

  it("refuses to overwrite a different date once already ready-to-implement, without mutating content", () => {
    const first = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "2026-08-28");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRatifyFrontmatter(first.content, "Alex Rivera", "2026-08-29");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("already ratified by Alex Rivera on 2026-08-28");
    expect(second.message).toContain("Alex Rivera on 2026-08-29");
  });

  it("re-ratifies cleanly when status has since moved off ready-to-implement (e.g. back to implemented)", () => {
    const implementedAfterHop =
      "---\n" +
      "schemaVersion: 1\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: implemented\n" +
      "version: 2\n" +
      "implementedIn: https://github.com/org/repo/pull/1\n" +
      "ratifiedBy: Alex Rivera\n" +
      "ratifiedOn: 2026-08-01\n" +
      "---\n" +
      "body\n";
    const result = applyRatifyFrontmatter(implementedAfterHop, "Jordan Lee", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("ratifiedBy: Jordan Lee");
    expect(result.content).toContain("ratifiedOn: 2026-08-28");
    expect(result.content).toContain("implementedIn: https://github.com/org/repo/pull/1"); // untouched
    expect(result.content).toContain("version: 2"); // untouched
  });

  it("replaces existing ratifiedBy/ratifiedOn values in place rather than duplicating the keys", () => {
    const alreadyRatified =
      "---\n" +
      "schemaVersion: 1\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: reviewed\n" +
      "version: 1\n" +
      "ratifiedBy: Stale Person\n" +
      "ratifiedOn: 2020-01-01\n" +
      "---\n" +
      "body\n";
    const result = applyRatifyFrontmatter(alreadyRatified, "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.match(/ratifiedBy:/g)?.length).toBe(1);
    expect(result.content.match(/ratifiedOn:/g)?.length).toBe(1);
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedOn: 2026-08-28");
  });

  it("touches only status/ratifiedBy/ratifiedOn even when frontmatter keys are out of the usual order", () => {
    const reordered =
      "---\n" +
      "schemaVersion: 1\n" +
      "ratifiedOn: 2020-01-01\n" +
      "pattern: state-change\n" +
      "ratifiedBy: Stale Person\n" +
      "swimlane: order\n" +
      "status: draft\n" +
      "version: 1\n" +
      "---\n" +
      "body\n";
    const result = applyRatifyFrontmatter(reordered, "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(
      "---\n" +
        "schemaVersion: 1\n" +
        "ratifiedOn: 2026-08-28\n" +
        "pattern: state-change\n" +
        "ratifiedBy: Alex Rivera\n" +
        "swimlane: order\n" +
        "status: ready-to-implement\n" +
        "version: 1\n" +
        "---\n" +
        "body\n",
    );
  });

  it("fills in a missing ratifiedOn when ratifiedBy is already present and status already matches", () => {
    const partiallyRatified =
      "---\n" +
      "schemaVersion: 1\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: ready-to-implement\n" +
      "version: 1\n" +
      "ratifiedBy: Alex Rivera\n" +
      "---\n" +
      "body\n";
    const result = applyRatifyFrontmatter(partiallyRatified, "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedOn: 2026-08-28");
  });

  it("refuses with a clear error when there is no frontmatter block at all", () => {
    const result = applyRatifyFrontmatter("# Just a heading\n\nbody\n", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: false, message: "no frontmatter block found" });
  });

  it("refuses with a clear error when the frontmatter has no status field", () => {
    const result = applyRatifyFrontmatter("---\nschemaVersion: 1\n---\nbody\n", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: false, message: "no `status:` field found in frontmatter" });
  });

  it("refuses a blank ratifier name", () => {
    expect(applyRatifyFrontmatter(DRAFT_DOC, "   ", "2026-08-28")).toEqual({
      ok: false,
      message: "a ratifier name is required (--by)",
    });
  });

  it("refuses a ratifier name with an embedded newline, leaving content untouched", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "Alex\nstatus: implemented", "2026-08-28");
    expect(result).toEqual({
      ok: false,
      message: "ratifier name must not contain control characters",
    });
  });

  it("allows a ratifier name with internal spaces (unlike mark-implemented's URL guard)", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
  });

  it("refuses a malformed date", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "not-a-date");
    expect(result).toEqual({ ok: false, message: 'invalid date "not-a-date" — expected YYYY-MM-DD' });
  });

  it("refuses a date with an out-of-range month", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "Alex Rivera", "2026-13-01");
    expect(result).toEqual({ ok: false, message: 'invalid date "2026-13-01" — expected YYYY-MM-DD' });
  });

  it("keeps the file's own line-ending style for inserted lines (CRLF)", () => {
    const crlf = DRAFT_DOC.replace(/\n/g, "\r\n");
    const result = applyRatifyFrontmatter(crlf, "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(
      "status: ready-to-implement\r\nratifiedBy: Alex Rivera\r\nratifiedOn: 2026-08-28\r\n",
    );
    expect(result.content.slice(result.content.indexOf("# Slice"))).toBe(crlf.slice(crlf.indexOf("# Slice")));
  });
});

describe("runRatify (note-binding resolution + fs orchestration)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-ratify-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "draft-slice.md"), DRAFT_DOC);
    writeFileSync(
      join(dir, "draft.em"),
      'slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n  event Thing Done\n}\n',
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
    // MIL-121 cross-binding: same shape as markImplemented.test.ts's "cross.em" fixture.
    writeFileSync(
      join(dir, "slices", "covering-slice.md"),
      "---\nschemaVersion: 1\npattern: automation\nswimlane: order\nstatus: draft\nversion: 1\ncovers: view-only\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "cross.em"),
      [
        'slice "View Only" {',
        '  view Some View from "Thing Done" note "slices/covering-slice.md"',
        "}",
        'slice "Covering Slice" {',
        '  processor Reacts from "Some View" note "slices/covering-slice.md"',
        "  command React",
        "  event Reacted",
        "}",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(file: string, sliceKey: string, by: string, on: string) {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runRatify(model, refs, dir, sliceKey, by, on);
  }

  it("flips a note-bound doc and writes it to disk", () => {
    const result = run("draft.em", "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: true, path: "slices/draft-slice.md", changed: true });
    const written = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("ratifiedBy: Alex Rivera");
    expect(written).toContain("ratifiedOn: 2026-08-28");
  });

  it("is idempotent on a second run with the same by/on pair (no write, changed: false)", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const result = run("draft.em", "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: true, path: "slices/draft-slice.md", changed: false });
    expect(readFileSync(join(dir, "slices", "draft-slice.md"), "utf8")).toBe(before);
  });

  it("refuses a different ratifier once already ready-to-implement", () => {
    const result = run("draft.em", "draft-slice", "Jordan Lee", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/draft-slice.md");
    expect(result.message).toContain("already ratified by Alex Rivera on 2026-08-28");
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const result = run("draft.em", "no-such-key", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });

  it("errors clearly when no doc is bound via note", () => {
    const result = run("unbound.em", "unbound", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("errors clearly when the bound note names a file that doesn't exist", () => {
    const result = run("ghost.em", "ghost", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/ghost.md");
    expect(result.message).toContain("no such file exists");
  });

  it("errors clearly when the bound doc has no usable frontmatter", () => {
    const result = run("invalid.em", "invalid", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/invalid.md");
    expect(result.message).toContain("invalid frontmatter");
  });

  it("resolves a MIL-121 cross-binding to the covering doc's own path and writes there", () => {
    const result = run("cross.em", "view-only", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: true, path: "slices/covering-slice.md", changed: true });
    const written = readFileSync(join(dir, "slices", "covering-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("ratifiedBy: Alex Rivera");
  });
});
