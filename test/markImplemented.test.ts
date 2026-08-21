// SPDX-License-Identifier: MIT
// Coverage for `em slice mark-implemented` (src/cli/markImplemented.ts, MIL-103): the pure
// frontmatter text-surgery (`applyImplementedFrontmatter`) and the note-binding resolution +
// fs orchestration (`runMarkImplemented`). CLI-level exit-code/process coverage (argument
// wiring, error-scoping to the named slice) lives in test/cli.test.ts, same split as
// `em slice index`/`em slice new`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { applyImplementedFrontmatter, runMarkImplemented } from "../src/cli/markImplemented.js";

const READY_DOC =
  "---\n" +
  "schemaVersion: 1\n" +
  "pattern: state-change\n" +
  "swimlane: order\n" +
  "status: ready-to-implement\n" +
  "version: 1\n" +
  "---\n" +
  "# Slice: Ready Slice\n" +
  "\n" +
  "## Intent\n" +
  "\n" +
  "Some body prose that must survive byte-for-byte.\n";

describe("applyImplementedFrontmatter (pure text surgery)", () => {
  it("flips status and adds a fresh implementedIn line, leaving version/body untouched", () => {
    const result = applyImplementedFrontmatter(READY_DOC, "https://github.com/org/repo/pull/42");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.content).toContain("status: implemented");
    expect(result.content).toContain("implementedIn: https://github.com/org/repo/pull/42");
    expect(result.content).toContain("version: 1"); // untouched
    // Body preserved byte-for-byte: everything from the body heading onward is identical.
    const bodyMarker = "# Slice: Ready Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      READY_DOC.slice(READY_DOC.indexOf(bodyMarker)),
    );
  });

  it("is idempotent: re-applying the same URL is a no-op with byte-identical content", () => {
    const first = applyImplementedFrontmatter(READY_DOC, "https://github.com/org/repo/pull/42");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyImplementedFrontmatter(first.content, "https://github.com/org/repo/pull/42");
    expect(second).toEqual({ ok: true, content: first.content, changed: false });
  });

  it("refuses to overwrite a different URL once already implemented, without mutating content", () => {
    const first = applyImplementedFrontmatter(READY_DOC, "https://github.com/org/repo/pull/42");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyImplementedFrontmatter(first.content, "https://github.com/org/repo/pull/999");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("existing: https://github.com/org/repo/pull/42");
    expect(second.message).toContain("requested: https://github.com/org/repo/pull/999");
  });

  it("replaces an existing implementedIn value in place rather than duplicating the key", () => {
    const withStaleImpl =
      "---\n" +
      "schemaVersion: 1\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: ready-to-implement\n" +
      "implementedIn: https://github.com/org/repo/pull/1\n" +
      "version: 2\n" +
      "---\n" +
      "body\n";
    const result = applyImplementedFrontmatter(withStaleImpl, "https://github.com/org/repo/pull/2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.match(/implementedIn:/g)?.length).toBe(1);
    expect(result.content).toContain("implementedIn: https://github.com/org/repo/pull/2");
    expect(result.content).toContain("version: 2");
  });

  it("touches only status/implementedIn even when frontmatter keys are out of the usual order", () => {
    const reordered =
      "---\n" +
      "schemaVersion: 1\n" +
      "implementedIn: stale\n" +
      "pattern: state-change\n" +
      "swimlane: order\n" +
      "status: ready-to-implement\n" +
      "version: 1\n" +
      "---\n" +
      "body\n";
    const result = applyImplementedFrontmatter(reordered, "https://x/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(
      "---\n" +
        "schemaVersion: 1\n" +
        "implementedIn: https://x/1\n" +
        "pattern: state-change\n" +
        "swimlane: order\n" +
        "status: implemented\n" +
        "version: 1\n" +
        "---\n" +
        "body\n",
    );
  });

  it("refuses with a clear error when there is no frontmatter block at all", () => {
    const result = applyImplementedFrontmatter("# Just a heading\n\nbody\n", "https://x/1");
    expect(result).toEqual({ ok: false, message: "no frontmatter block found" });
  });

  it("refuses with a clear error when the frontmatter has no status field", () => {
    const result = applyImplementedFrontmatter("---\nschemaVersion: 1\n---\nbody\n", "https://x/1");
    expect(result).toEqual({ ok: false, message: "no `status:` field found in frontmatter" });
  });

  it("refuses a blank pr-url", () => {
    expect(applyImplementedFrontmatter(READY_DOC, "   ")).toEqual({ ok: false, message: "a PR URL is required" });
  });

  it("keeps the file's own line-ending style for an inserted implementedIn line (CRLF)", () => {
    const crlf = READY_DOC.replace(/\n/g, "\r\n");
    const result = applyImplementedFrontmatter(crlf, "https://x/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: implemented\r\nimplementedIn: https://x/1\r\n");
    expect(result.content.slice(result.content.indexOf("# Slice"))).toBe(crlf.slice(crlf.indexOf("# Slice")));
  });
});

describe("runMarkImplemented (note-binding resolution + fs orchestration)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-mark-implemented-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "ready-slice.md"), READY_DOC);
    writeFileSync(
      join(dir, "ready.em"),
      'slice "Ready Slice" {\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\n',
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
    // MIL-121 cross-binding: a view-only slice covered by the reaction slice's own doc — same
    // shape as sliceReadyValidate.test.ts's "request-payment" fixture: the doc's canonical path
    // matches the REACTION slice's own key, and its `covers:` list ratifies the view-only slice.
    writeFileSync(
      join(dir, "slices", "covering-slice.md"),
      "---\nschemaVersion: 1\npattern: automation\nswimlane: order\nstatus: ready-to-implement\nversion: 1\ncovers: view-only\n---\nbody\n",
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

  function run(file: string, sliceKey: string, prUrl: string) {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runMarkImplemented(model, refs, dir, sliceKey, prUrl);
  }

  it("flips a note-bound doc and writes it to disk", () => {
    const result = run("ready.em", "ready-slice", "https://github.com/org/repo/pull/42");
    expect(result).toEqual({ ok: true, path: "slices/ready-slice.md", changed: true });
    const written = readFileSync(join(dir, "slices", "ready-slice.md"), "utf8");
    expect(written).toContain("status: implemented");
    expect(written).toContain("implementedIn: https://github.com/org/repo/pull/42");
  });

  it("is idempotent on a second run with the same URL (no write, changed: false)", () => {
    const before = readFileSync(join(dir, "slices", "ready-slice.md"), "utf8");
    const result = run("ready.em", "ready-slice", "https://github.com/org/repo/pull/42");
    expect(result).toEqual({ ok: true, path: "slices/ready-slice.md", changed: false });
    expect(readFileSync(join(dir, "slices", "ready-slice.md"), "utf8")).toBe(before);
  });

  it("refuses a different URL once implemented", () => {
    const result = run("ready.em", "ready-slice", "https://github.com/org/repo/pull/999");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/ready-slice.md");
    expect(result.message).toContain("already marked implemented with a different URL");
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const result = run("ready.em", "no-such-key", "https://x/1");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });

  it("errors clearly when no doc is bound via note", () => {
    const result = run("unbound.em", "unbound", "https://x/1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("errors clearly when the bound note names a file that doesn't exist", () => {
    const result = run("ghost.em", "ghost", "https://x/1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/ghost.md");
    expect(result.message).toContain("no such file exists");
  });

  it("errors clearly when the bound doc has no usable frontmatter", () => {
    const result = run("invalid.em", "invalid", "https://x/1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/invalid.md");
    expect(result.message).toContain("invalid frontmatter");
  });

  it("resolves a MIL-121 cross-binding to the covering doc's own path and writes there", () => {
    const result = run("cross.em", "view-only", "https://github.com/org/repo/pull/7");
    expect(result).toEqual({ ok: true, path: "slices/covering-slice.md", changed: true });
    const written = readFileSync(join(dir, "slices", "covering-slice.md"), "utf8");
    expect(written).toContain("status: implemented");
    expect(written).toContain("implementedIn: https://github.com/org/repo/pull/7");
  });
});
