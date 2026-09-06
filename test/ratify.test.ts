// SPDX-License-Identifier: MIT
// Coverage for `em slice ratify` (src/cli/ratify.ts, MIL-165): the pure frontmatter text-surgery
// (`applyRatifyFrontmatter`) and the note-binding resolution + fs orchestration (`runRatify`).
// Mirrors test/markImplemented.test.ts's structure and idempotency-discipline coverage — the two
// commands share the same shape. CLI-level exit-code/process coverage (argument wiring, error-
// scoping to the named slice, --on validation) lives in test/cli.test.ts.
//
// MIL-201 added the review gate: ratification only applies to a doc already at `status: reviewed`
// (the ordinary path, written by `em slice review`) or `ready-to-implement` (the idempotent re-run
// and the post-`reratify` path), unless `--skip-review` is passed. Most fixtures below therefore
// start at `reviewed` rather than `draft`; the gate's own refusal/skip behavior has its own
// describe block at the bottom of the pure-transform section.
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

/** The same doc after `em slice review` walked it — the ordinary input to `ratify` now that the
 *  review gate (MIL-201) exists. */
const REVIEWED_DOC = DRAFT_DOC.replace("status: draft", "status: reviewed");

/** A doc that already shipped and carries the prior version's sign-off. */
const IMPLEMENTED_AFTER_HOP =
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

describe("applyRatifyFrontmatter (pure text surgery)", () => {
  it("flips status and adds fresh ratifiedBy/ratifiedOn lines, leaving version/body untouched", () => {
    const result = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedOn: 2026-08-28");
    expect(result.content).toContain("version: 1"); // untouched
    const bodyMarker = "# Slice: Draft Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      REVIEWED_DOC.slice(REVIEWED_DOC.indexOf(bodyMarker)),
    );
  });

  it("is idempotent: re-applying the same by/on pair is a no-op with byte-identical content", () => {
    const first = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRatifyFrontmatter(first.content, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(second).toEqual({ ok: true, content: first.content, changed: false, skippedReviewFrom: null });
  });

  it("refuses to overwrite a different ratifier once already ready-to-implement, without mutating content", () => {
    const first = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRatifyFrontmatter(first.content, "draft-slice", "Jordan Lee", "2026-08-28");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("already ratified by Alex Rivera on 2026-08-28");
    expect(second.message).toContain("Jordan Lee on 2026-08-28");
  });

  it("refuses to overwrite a different date once already ready-to-implement, without mutating content", () => {
    const first = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyRatifyFrontmatter(first.content, "draft-slice", "Alex Rivera", "2026-08-29");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("already ratified by Alex Rivera on 2026-08-28");
    expect(second.message).toContain("Alex Rivera on 2026-08-29");
  });

  // MIL-201 changed this case: a shipped doc is reopened with `em slice reratify` (which lands it
  // at `ready-to-implement`), not ratified straight from `implemented` — the review gate refuses
  // that hop now. `--skip-review` still forces it through, byte-for-byte as before.
  it("refuses a doc that has since moved on to implemented — reratify reopens it, not ratify", () => {
    const result = applyRatifyFrontmatter(IMPLEMENTED_AFTER_HOP, "shipped-slice", "Jordan Lee", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'slice "shipped-slice" is `status: implemented` — the review gate comes first: run ' +
        "`em slice review <file> <key> --by <name>` after the review session, or pass " +
        "--skip-review to ratify without one",
    );
  });

  it("re-ratifies a doc that has moved on to implemented when --skip-review forces it", () => {
    const result = applyRatifyFrontmatter(IMPLEMENTED_AFTER_HOP, "shipped-slice", "Jordan Lee", "2026-08-28", true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.skippedReviewFrom).toBe("implemented");
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
    const result = applyRatifyFrontmatter(alreadyRatified, "draft-slice", "Alex Rivera", "2026-08-28");
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
      "status: reviewed\n" +
      "version: 1\n" +
      "---\n" +
      "body\n";
    const result = applyRatifyFrontmatter(reordered, "draft-slice", "Alex Rivera", "2026-08-28");
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
    const result = applyRatifyFrontmatter(partiallyRatified, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedOn: 2026-08-28");
  });

  it("refuses with a clear error when there is no frontmatter block at all", () => {
    const result = applyRatifyFrontmatter("# Just a heading\n\nbody\n", "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: false, message: "no frontmatter block found" });
  });

  it("refuses with a clear error when the frontmatter has no status field", () => {
    const result = applyRatifyFrontmatter("---\nschemaVersion: 1\n---\nbody\n", "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: false, message: "no `status:` field found in frontmatter" });
  });

  it("refuses a blank ratifier name", () => {
    expect(applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "   ", "2026-08-28")).toEqual({
      ok: false,
      message: "a ratifier name is required (--by)",
    });
  });

  it("refuses a ratifier name with an embedded newline, leaving content untouched", () => {
    const result = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex\nstatus: implemented", "2026-08-28");
    expect(result).toEqual({
      ok: false,
      message: "ratifier name must not contain control characters",
    });
  });

  it("allows a ratifier name with internal spaces (unlike mark-implemented's URL guard)", () => {
    const result = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
  });

  it("refuses a malformed date", () => {
    const result = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "not-a-date");
    expect(result).toEqual({ ok: false, message: 'invalid date "not-a-date" — expected YYYY-MM-DD' });
  });

  it("refuses a date with an out-of-range month", () => {
    const result = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-13-01");
    expect(result).toEqual({ ok: false, message: 'invalid date "2026-13-01" — expected YYYY-MM-DD' });
  });

  it("keeps the file's own line-ending style for inserted lines (CRLF)", () => {
    const crlf = REVIEWED_DOC.replace(/\n/g, "\r\n");
    const result = applyRatifyFrontmatter(crlf, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain(
      "status: ready-to-implement\r\nratifiedBy: Alex Rivera\r\nratifiedOn: 2026-08-28\r\n",
    );
    expect(result.content.slice(result.content.indexOf("# Slice"))).toBe(crlf.slice(crlf.indexOf("# Slice")));
  });
});

describe("applyRatifyFrontmatter — the review gate (MIL-201, D1)", () => {
  it("refuses a draft doc with the exact gate message, leaving content untouched", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({
      ok: false,
      message:
        'slice "draft-slice" is `status: draft` — the review gate comes first: run ' +
        "`em slice review <file> <key> --by <name>` after the review session, or pass " +
        "--skip-review to ratify without one",
    });
  });

  it("names the doc's actual status in the refusal", () => {
    const odd = DRAFT_DOC.replace("status: draft", "status: parked");
    const result = applyRatifyFrontmatter(odd, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('slice "draft-slice" is `status: parked`');
  });

  it("reports an empty status as `(empty)` rather than a bare backtick pair", () => {
    const blank = DRAFT_DOC.replace("status: draft", "status:");
    const result = applyRatifyFrontmatter(blank, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("`status: (empty)`");
  });

  it("lets a reviewed doc through with skippedReviewFrom null — the gate passed on its merits", () => {
    const result = applyRatifyFrontmatter(REVIEWED_DOC, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skippedReviewFrom).toBeNull();
  });

  it("lets a ready-to-implement doc through — the post-reratify path needs no fresh review", () => {
    const afterReratify =
      "---\n" +
      "schemaVersion: 1\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: ready-to-implement\n" +
      "version: 2\n" +
      "implementedIn: https://github.com/org/repo/pull/1\n" +
      "---\n" +
      "body\n";
    const result = applyRatifyFrontmatter(afterReratify, "shipped-slice", "Jordan Lee", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.skippedReviewFrom).toBeNull();
    expect(result.content).toContain("ratifiedBy: Jordan Lee");
  });

  it("applies with --skip-review from draft and reports the status it skipped", () => {
    const result = applyRatifyFrontmatter(DRAFT_DOC, "draft-slice", "Alex Rivera", "2026-08-28", true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.skippedReviewFrom).toBe("draft");
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
  });

  it("never clears reviewedBy/reviewedOn — the review record is provenance ratify doesn't consume", () => {
    const reviewed =
      REVIEWED_DOC.replace("status: reviewed\n", "status: reviewed\nreviewedBy: Sam Okafor\nreviewedOn: 2026-08-20\n");
    const result = applyRatifyFrontmatter(reviewed, "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("reviewedBy: Sam Okafor");
    expect(result.content).toContain("reviewedOn: 2026-08-20");
    expect(result.content).toContain("status: ready-to-implement");
  });

  it("the gate never fires before the --by/--on validation guards", () => {
    expect(applyRatifyFrontmatter(DRAFT_DOC, "draft-slice", "  ", "2026-08-28")).toEqual({
      ok: false,
      message: "a ratifier name is required (--by)",
    });
    expect(applyRatifyFrontmatter(DRAFT_DOC, "draft-slice", "Alex Rivera", "nope")).toEqual({
      ok: false,
      message: 'invalid date "nope" — expected YYYY-MM-DD',
    });
  });
});

describe("runRatify (note-binding resolution + fs orchestration)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-ratify-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "draft-slice.md"), REVIEWED_DOC);
    writeFileSync(
      join(dir, "draft.em"),
      'slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n  event Thing Done\n}\n',
    );
    writeFileSync(join(dir, "unbound.em"), 'slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n');
    // MIL-201: a doc still at `status: draft` — the review gate's own fixture.
    writeFileSync(join(dir, "slices", "gated-slice.md"), DRAFT_DOC);
    writeFileSync(
      join(dir, "gated.em"),
      'slice "Gated Slice" {\n  command Do Thing note "slices/gated-slice.md"\n  event Thing Done\n}\n',
    );
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
      "---\nschemaVersion: 1\npattern: automation\nswimlane: order\nstatus: reviewed\nversion: 1\ncovers: view-only\n---\nbody\n",
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

  function run(file: string, sliceKey: string, by: string, on: string, skipReview = false) {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runRatify(model, refs, dir, sliceKey, by, on, skipReview);
  }

  it("flips a note-bound doc and writes it to disk", () => {
    const result = run("draft.em", "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: true, path: "slices/draft-slice.md", changed: true, skippedReviewFrom: null });
    const written = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("ratifiedBy: Alex Rivera");
    expect(written).toContain("ratifiedOn: 2026-08-28");
  });

  it("is idempotent on a second run with the same by/on pair (no write, changed: false)", () => {
    const before = readFileSync(join(dir, "slices", "draft-slice.md"), "utf8");
    const result = run("draft.em", "draft-slice", "Alex Rivera", "2026-08-28");
    expect(result).toEqual({ ok: true, path: "slices/draft-slice.md", changed: false, skippedReviewFrom: null });
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
    expect(result).toEqual({ ok: true, path: "slices/covering-slice.md", changed: true, skippedReviewFrom: null });
    const written = readFileSync(join(dir, "slices", "covering-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("ratifiedBy: Alex Rivera");
  });

  it("refuses a draft doc at the review gate, leaving the file byte-untouched (MIL-201)", () => {
    const before = readFileSync(join(dir, "slices", "gated-slice.md"), "utf8");
    const result = run("gated.em", "gated-slice", "Alex Rivera", "2026-08-28");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'slices/gated-slice.md: slice "gated-slice" is `status: draft` — the review gate comes ' +
        "first: run `em slice review <file> <key> --by <name>` after the review session, or pass " +
        "--skip-review to ratify without one",
    );
    expect(readFileSync(join(dir, "slices", "gated-slice.md"), "utf8")).toBe(before);
  });

  it("writes the draft doc when skipReview is set, reporting the skipped status (MIL-201)", () => {
    const result = run("gated.em", "gated-slice", "Alex Rivera", "2026-08-28", true);
    expect(result).toEqual({
      ok: true,
      path: "slices/gated-slice.md",
      changed: true,
      skippedReviewFrom: "draft",
    });
    const written = readFileSync(join(dir, "slices", "gated-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("ratifiedBy: Alex Rivera");
  });
});
