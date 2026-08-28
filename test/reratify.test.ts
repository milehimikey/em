// SPDX-License-Identifier: MIT
// Coverage for `em slice reratify` (src/cli/reratify.ts, MIL-161): the pure frontmatter text-
// surgery (`applyReratifyFrontmatter`) and the note-binding resolution + fs orchestration
// (`runReratify`). Mirrors test/ratify.test.ts/test/markImplemented.test.ts's structure — all
// three lifecycle-flip commands share the same shape. CLI-level exit-code/process coverage
// lives in test/cli.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { applyReratifyFrontmatter, runReratify } from "../src/cli/reratify.js";

const IMPLEMENTED_DOC =
  "---\n" +
  "schemaVersion: 1\n" +
  "pattern: state-change\n" +
  "swimlane: order\n" +
  "status: implemented\n" +
  "version: 1\n" +
  "implementedIn: https://github.com/org/repo/pull/1\n" +
  "ratifiedBy: Alex Rivera\n" +
  "ratifiedOn: 2026-08-01\n" +
  "---\n" +
  "# Slice: Shipped Slice\n" +
  "\n" +
  "## Intent\n" +
  "\n" +
  "Some body prose that must survive byte-for-byte.\n";

describe("applyReratifyFrontmatter (pure text surgery)", () => {
  it("bumps version, flips status, and clears stale ratifiedBy/ratifiedOn, leaving implementedIn/body untouched", () => {
    const result = applyReratifyFrontmatter(IMPLEMENTED_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newVersion).toBe(2);
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("version: 2");
    expect(result.content).toContain("implementedIn: https://github.com/org/repo/pull/1"); // untouched
    expect(result.content).not.toContain("ratifiedBy:");
    expect(result.content).not.toContain("ratifiedOn:");
    const bodyMarker = "# Slice: Shipped Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      IMPLEMENTED_DOC.slice(IMPLEMENTED_DOC.indexOf(bodyMarker)),
    );
  });

  it("refuses a doc that's still draft — nothing has shipped yet to re-ratify", () => {
    const draft =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n";
    const result = applyReratifyFrontmatter(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("status: draft");
    expect(result.message).toContain("not `implemented`");
  });

  it("refuses a doc already ready-to-implement — a bump here would silently double-increment", () => {
    const alreadyReratified =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 2\n---\nbody\n";
    const result = applyReratifyFrontmatter(alreadyReratified);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("status: ready-to-implement");
  });

  it("refuses with a clear error when there is no frontmatter block at all", () => {
    const result = applyReratifyFrontmatter("# Just a heading\n\nbody\n");
    expect(result).toEqual({ ok: false, message: "no frontmatter block found" });
  });

  it("refuses with a clear error when the frontmatter has no status field", () => {
    const result = applyReratifyFrontmatter("---\nschemaVersion: 1\n---\nbody\n");
    expect(result).toEqual({ ok: false, message: "no `status:` field found in frontmatter" });
  });

  it("refuses with a clear error when the frontmatter has no version field", () => {
    const noVersion = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\n---\nbody\n";
    const result = applyReratifyFrontmatter(noVersion);
    expect(result).toEqual({ ok: false, message: "no `version:` field found in frontmatter" });
  });

  it("refuses rather than guess when version isn't a positive integer", () => {
    const badVersion =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: not-a-number\n---\nbody\n";
    const result = applyReratifyFrontmatter(badVersion);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"not-a-number"');
    expect(result.message).toContain("isn't a positive integer");
  });

  it("bumps cleanly when ratifiedBy/ratifiedOn are absent (never-ratified-through-the-command doc)", () => {
    const noProvenance =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 3\nimplementedIn: https://example.com/pr/9\n---\nbody\n";
    const result = applyReratifyFrontmatter(noProvenance);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newVersion).toBe(4);
    expect(result.content).toContain("version: 4");
    expect(result.content).toContain("status: ready-to-implement");
  });

  it("touches only status/version/ratifiedBy/ratifiedOn even when frontmatter keys are out of the usual order", () => {
    const reordered =
      "---\n" +
      "schemaVersion: 1\n" +
      "ratifiedOn: 2026-08-01\n" +
      "pattern: state-change\n" +
      "ratifiedBy: Alex Rivera\n" +
      "swimlane: order\n" +
      "version: 5\n" +
      "status: implemented\n" +
      "implementedIn: https://example.com/pr/9\n" +
      "---\n" +
      "body\n";
    const result = applyReratifyFrontmatter(reordered);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe(
      "---\n" +
        "schemaVersion: 1\n" +
        "pattern: state-change\n" +
        "swimlane: order\n" +
        "version: 6\n" +
        "status: ready-to-implement\n" +
        "implementedIn: https://example.com/pr/9\n" +
        "---\n" +
        "body\n",
    );
  });

  it("keeps the file's own line-ending style (CRLF)", () => {
    const crlf = IMPLEMENTED_DOC.replace(/\n/g, "\r\n");
    const result = applyReratifyFrontmatter(crlf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: ready-to-implement\r\n");
    expect(result.content.slice(result.content.indexOf("# Slice"))).toBe(crlf.slice(crlf.indexOf("# Slice")));
  });
});

describe("runReratify (note-binding resolution + fs orchestration)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-reratify-"));
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
    // MIL-121 cross-binding: same shape as ratify.test.ts/markImplemented.test.ts's fixtures.
    writeFileSync(
      join(dir, "slices", "covering-slice.md"),
      "---\nschemaVersion: 1\npattern: automation\nswimlane: order\nstatus: implemented\nversion: 1\nimplementedIn: https://example.com/pr/1\ncovers: view-only\n---\nbody\n",
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

  function run(file: string, sliceKey: string) {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runReratify(model, refs, dir, sliceKey);
  }

  it("bumps a note-bound doc and writes it to disk", () => {
    const result = run("shipped.em", "shipped-slice");
    expect(result).toEqual({ ok: true, path: "slices/shipped-slice.md", newVersion: 2 });
    const written = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("version: 2");
    expect(written).not.toContain("ratifiedBy:");
  });

  it("refuses a second run — already reratified (status is no longer implemented)", () => {
    const result = run("shipped.em", "shipped-slice");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/shipped-slice.md");
    expect(result.message).toContain("status: ready-to-implement");
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const result = run("shipped.em", "no-such-key");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });

  it("errors clearly when no doc is bound via note", () => {
    const result = run("unbound.em", "unbound");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no doc bound via `note "slices/unbound.md"`');
  });

  it("errors clearly when the bound note names a file that doesn't exist", () => {
    const result = run("ghost.em", "ghost");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/ghost.md");
    expect(result.message).toContain("no such file exists");
  });

  it("errors clearly when the bound doc has no usable frontmatter", () => {
    const result = run("invalid.em", "invalid");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("slices/invalid.md");
    expect(result.message).toContain("invalid frontmatter");
  });

  it("resolves a MIL-121 cross-binding to the covering doc's own path and writes there", () => {
    const result = run("cross.em", "view-only");
    expect(result).toEqual({ ok: true, path: "slices/covering-slice.md", newVersion: 2 });
    const written = readFileSync(join(dir, "slices", "covering-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("version: 2");
  });
});
