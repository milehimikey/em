// SPDX-License-Identifier: MIT
// Coverage for `em slice review` (src/cli/review.ts, MIL-201): the pure frontmatter text-surgery
// (`applyReviewFrontmatter`) and the note-binding resolution + fs orchestration (`runReview`).
// Deliberately mirrors test/ratify.test.ts case for case — the two commands are the two human
// gates of one lifecycle and share every mechanic, so a divergence in behavior should show up as
// a divergence between these two files. CLI-level exit-code/process coverage (argument wiring,
// error-scoping to the named slice, --on validation) lives in test/cli.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { applyReviewFrontmatter, runReview } from "../src/cli/review.js";

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

describe("applyReviewFrontmatter (pure text surgery)", () => {
  it("flips a draft doc's status and adds fresh reviewedBy/reviewedOn, leaving version/body untouched", () => {
    const result = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("status: reviewed");
    expect(result.content).toContain("reviewedBy: Sam Okafor");
    expect(result.content).toContain("reviewedOn: 2026-09-05");
    expect(result.content).toContain("version: 1"); // untouched
    const bodyMarker = "# Slice: Draft Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      DRAFT_DOC.slice(DRAFT_DOC.indexOf(bodyMarker)),
    );
  });

  it("inserts the two new keys immediately after the status line", () => {
    const result = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: reviewed\nreviewedBy: Sam Okafor\nreviewedOn: 2026-09-05\n");
  });

  it("is idempotent: re-applying the same by/on pair is a no-op with byte-identical content", () => {
    const first = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-09-05");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyReviewFrontmatter(first.content, "Sam Okafor", "2026-09-05");
    expect(second).toEqual({ ok: true, content: first.content, changed: false });
  });

  it("refuses to overwrite a different reviewer once already reviewed, without mutating content", () => {
    const first = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-09-05");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyReviewFrontmatter(first.content, "Robin Vale", "2026-09-05");
    expect(second).toEqual({
      ok: false,
      message: "already reviewed by Sam Okafor on 2026-09-05 — refusing to overwrite with Robin Vale on 2026-09-05",
    });
  });

  it("refuses to overwrite a different date once already reviewed", () => {
    const first = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-09-05");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyReviewFrontmatter(first.content, "Sam Okafor", "2026-09-06");
    expect(second).toEqual({
      ok: false,
      message: "already reviewed by Sam Okafor on 2026-09-05 — refusing to overwrite with Sam Okafor on 2026-09-06",
    });
  });

  it("refuses a ready-to-implement doc with the exact message pointing at reratify", () => {
    const ratified = DRAFT_DOC.replace("status: draft", "status: ready-to-implement");
    const result = applyReviewFrontmatter(ratified, "Sam Okafor", "2026-09-05");
    expect(result).toEqual({
      ok: false,
      message:
        "doc is `status: ready-to-implement` — review applies before ratification; a shipped " +
        "slice is reopened with `em slice reratify`",
    });
  });

  it("refuses an implemented doc with the exact message pointing at reratify", () => {
    const implemented = DRAFT_DOC.replace("status: draft", "status: implemented");
    const result = applyReviewFrontmatter(implemented, "Sam Okafor", "2026-09-05");
    expect(result).toEqual({
      ok: false,
      message:
        "doc is `status: implemented` — review applies before ratification; a shipped " +
        "slice is reopened with `em slice reratify`",
    });
  });

  it("re-reviews a reviewed doc that carries no recorded reviewer yet (a hand-edited status)", () => {
    const handEdited = DRAFT_DOC.replace("status: draft", "status: reviewed");
    const result = applyReviewFrontmatter(handEdited, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("reviewedBy: Sam Okafor");
  });

  it("replaces existing reviewedBy/reviewedOn values in place rather than duplicating the keys", () => {
    const stale =
      "---\n" +
      "schemaVersion: 1\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: draft\n" +
      "version: 1\n" +
      "reviewedBy: Stale Person\n" +
      "reviewedOn: 2020-01-01\n" +
      "---\n" +
      "body\n";
    const result = applyReviewFrontmatter(stale, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.match(/reviewedBy:/g)?.length).toBe(1);
    expect(result.content.match(/reviewedOn:/g)?.length).toBe(1);
    expect(result.content).toContain("reviewedBy: Sam Okafor");
    expect(result.content).toContain("reviewedOn: 2026-09-05");
  });

  it("touches only status/reviewedBy/reviewedOn even when frontmatter keys are out of the usual order", () => {
    const reordered =
      "---\n" +
      "schemaVersion: 1\n" +
      "reviewedOn: 2020-01-01\n" +
      "pattern: state-change\n" +
      "reviewedBy: Stale Person\n" +
      "swimlane: order\n" +
      "status: draft\n" +
      "version: 1\n" +
      "---\n" +
      "body\n";
    const result = applyReviewFrontmatter(reordered, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(
      "---\n" +
        "schemaVersion: 1\n" +
        "reviewedOn: 2026-09-05\n" +
        "pattern: state-change\n" +
        "reviewedBy: Sam Okafor\n" +
        "swimlane: order\n" +
        "status: reviewed\n" +
        "version: 1\n" +
        "---\n" +
        "body\n",
    );
  });

  it("leaves ratifiedBy/ratifiedOn alone — review never touches the other gate's record", () => {
    const stale = DRAFT_DOC.replace(
      "version: 1\n",
      "version: 1\nratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\n",
    );
    const result = applyReviewFrontmatter(stale, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedOn: 2026-08-01");
  });

  it("refuses with a clear error when there is no frontmatter block at all", () => {
    const result = applyReviewFrontmatter("# Just a heading\n\nbody\n", "Sam Okafor", "2026-09-05");
    expect(result).toEqual({ ok: false, message: "no frontmatter block found" });
  });

  it("refuses with a clear error when the frontmatter has no status field", () => {
    const result = applyReviewFrontmatter("---\nschemaVersion: 1\n---\nbody\n", "Sam Okafor", "2026-09-05");
    expect(result).toEqual({ ok: false, message: "no `status:` field found in frontmatter" });
  });

  it("refuses a blank reviewer name", () => {
    expect(applyReviewFrontmatter(DRAFT_DOC, "   ", "2026-09-05")).toEqual({
      ok: false,
      message: "a reviewer name is required (--by)",
    });
  });

  it("refuses a reviewer name with an embedded newline, leaving content untouched", () => {
    const result = applyReviewFrontmatter(DRAFT_DOC, "Sam\nstatus: implemented", "2026-09-05");
    expect(result).toEqual({
      ok: false,
      message: "reviewer name must not contain control characters",
    });
  });

  it("allows a reviewer name with internal spaces", () => {
    const result = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("reviewedBy: Sam Okafor");
  });

  it("refuses a malformed date", () => {
    const result = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "not-a-date");
    expect(result).toEqual({ ok: false, message: 'invalid date "not-a-date" — expected YYYY-MM-DD' });
  });

  it("refuses a date with an out-of-range month", () => {
    const result = applyReviewFrontmatter(DRAFT_DOC, "Sam Okafor", "2026-13-01");
    expect(result).toEqual({ ok: false, message: 'invalid date "2026-13-01" — expected YYYY-MM-DD' });
  });

  it("keeps the file's own line-ending style for inserted lines (CRLF)", () => {
    const crlf = DRAFT_DOC.replace(/\n/g, "\r\n");
    const result = applyReviewFrontmatter(crlf, "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: reviewed\r\nreviewedBy: Sam Okafor\r\nreviewedOn: 2026-09-05\r\n");
    expect(result.content.slice(result.content.indexOf("# Slice"))).toBe(crlf.slice(crlf.indexOf("# Slice")));
  });
});

describe("runReview (note-binding resolution + fs orchestration)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-review-"));
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
    writeFileSync(
      join(dir, "slices", "shipped-slice.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\n" +
        "implementedIn: https://github.com/org/repo/pull/1\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "shipped.em"),
      'slice "Shipped Slice" {\n  command Do Thing note "slices/shipped-slice.md"\n  event Thing Done\n}\n',
    );
    // MIL-121 cross-binding: same shape as ratify.test.ts's "cross.em" fixture.
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
    return runReview(model, refs, dir, sliceKey, by, on);
  }

  it("flips a note-bound doc and writes it to disk", () => {
    const result = run("draft.em", "draft-slice", "Sam Okafor", "2026-09-05");
    expect(result).toEqual({ ok: true, path: "slices/draft-slice.md", changed: true });
    const written = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    expect(written).toContain("status: reviewed");
    expect(written).toContain("reviewedBy: Sam Okafor");
    expect(written).toContain("reviewedOn: 2026-09-05");
  });

  it("is idempotent on a second run with the same by/on pair (no write, changed: false)", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const result = run("draft.em", "draft-slice", "Sam Okafor", "2026-09-05");
    expect(result).toEqual({ ok: true, path: "slices/draft-slice.md", changed: false });
    expect(readFileSync(join(dir, "slices", "draft-slice.md"), "utf8")).toBe(before);
  });

  it("refuses a different reviewer once already reviewed, leaving the file byte-untouched", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const result = run("draft.em", "draft-slice", "Robin Vale", "2026-09-05");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "slices/draft-slice.md: already reviewed by Sam Okafor on 2026-09-05 — refusing to " +
        "overwrite with Robin Vale on 2026-09-05",
    );
    expect(readFileSync(join(dir, "slices", "draft-slice.md"), "utf8")).toBe(before);
  });

  it("refuses a shipped doc, leaving the file byte-untouched", () => {
    const before = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    const result = run("shipped.em", "shipped-slice", "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "slices/shipped-slice.md: doc is `status: implemented` — review applies before " +
        "ratification; a shipped slice is reopened with `em slice reratify`",
    );
    expect(readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8")).toBe(before);
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const result = run("draft.em", "no-such-key", "Sam Okafor", "2026-09-05");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });

  it("errors clearly when no doc is bound via note", () => {
    const result = run("unbound.em", "unbound", "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no doc bound via `note "slices/unbound.md"`');
    expect(result.message).toContain("before reviewing it");
  });

  it("errors clearly when the bound note names a file that doesn't exist", () => {
    const result = run("ghost.em", "ghost", "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/ghost.md");
    expect(result.message).toContain("no such file exists");
  });

  it("errors clearly when the bound doc has no usable frontmatter", () => {
    const result = run("invalid.em", "invalid", "Sam Okafor", "2026-09-05");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/invalid.md");
    expect(result.message).toContain("invalid frontmatter");
  });

  it("resolves a MIL-121 cross-binding to the covering doc's own path and writes there", () => {
    const result = run("cross.em", "view-only", "Sam Okafor", "2026-09-05");
    expect(result).toEqual({ ok: true, path: "slices/covering-slice.md", changed: true });
    const written = readFileSync(join(dir, "slices", "covering-slice.md"), "utf8");
    expect(written).toContain("status: reviewed");
    expect(written).toContain("reviewedBy: Sam Okafor");
  });
});
