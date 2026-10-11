// SPDX-License-Identifier: MIT
// Coverage for `em slice revise` (src/cli/revise.ts, MIL-283) — the successor of `reratify`
// (MIL-161/258): the next version opens as a real `draft`, the shipped version stays shipped in
// the shipped record, the sign-off is cleared, deferred questions come back. Pure text surgery
// (applyReviseFrontmatter / openNextDraft), the fs orchestration (runRevise), the MIL-214
// advisory, and the `reratify` alias through the CLI.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { applyReviseFrontmatter, openNextDraft, runRevise, reviseAdvisory } from "../src/cli/revise.js";
import { parseSliceDoc, shippedRecordOf } from "../src/catalog/sliceDoc.js";
import { serializeFindingsDoc } from "../src/cli/findings.js";

vi.setConfig({ testTimeout: 20_000 });
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });

const REF = "3f9c2e1a3f9c2e1a3f9c2e1a3f9c2e1a3f9c2e1a";
const BODY = "# Slice: Shipped Slice\n\n## Intent\n\nSome body prose that must survive byte-for-byte.\n";
/** A 1.15 doc as `em slice mark-implemented` leaves it: shipped record + sign-off. */
const SHIPPED_115 =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\n" +
  "implementedIn: https://github.com/org/repo/pull/1\nshippedVersion: 1\nshippedRef: " + REF + "\nshippedOn: 2026-10-12\n" +
  "version: 1\nreviewedBy: Sam\nreviewedOn: 2026-08-01\nratifiedBy: Alex Rivera\nratifiedOn: 2026-08-02\n" +
  "ratifiedRef: " + REF + "\nratifiedHash: sha256:00\nmeaningConfirmed: true\n---\n" + BODY;
/** A pre-1.15 doc: no shipped record keys, `status: implemented` is the shipped fact. */
const SHIPPED_PRE =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: implemented\nversion: 1\n" +
  "implementedIn: https://github.com/org/repo/pull/1\nratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\n---\n" + BODY;
const RATIFIED_UNSHIPPED =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n" +
  "ratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\nratifiedHash: sha256:00\n---\n" + BODY;
const LEGACY_UNSIGNED = "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 2\nimplementedIn: https://github.com/org/repo/pull/1\n---\n" + BODY;

describe("applyReviseFrontmatter (pure, MIL-283)", () => {
  it("shipped (1.15 doc): status → draft, version bumped, sign-off cleared, shipped record and body untouched", () => {
    const r = applyReviseFrontmatter(SHIPPED_115);
    expect(r).toMatchObject({ ok: true, kind: "shipped", newVersion: 2, reopened: 0 });
    if (!r.ok) return;
    expect(r.content).toBe(
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\n" +
        "implementedIn: https://github.com/org/repo/pull/1\nshippedVersion: 1\nshippedRef: " + REF + "\nshippedOn: 2026-10-12\n" +
        "version: 2\n---\n" + BODY,
    );
    const parsed = parseSliceDoc(r.content);
    expect(shippedRecordOf(parsed)).toEqual({ version: 1, ratifiedRef: REF, implementedIn: "https://github.com/org/repo/pull/1", on: "2026-10-12" });
    expect(parsed.status).toBe("draft");
  });

  it("shipped (pre-1.15 doc): materialises shippedVersion/shippedRef before the status leaves implemented", () => {
    const withRef = SHIPPED_PRE.replace("ratifiedOn: 2026-08-01\n", `ratifiedOn: 2026-08-01\nratifiedRef: ${REF}\n`);
    const r = applyReviseFrontmatter(withRef);
    expect(r).toMatchObject({ ok: true, kind: "shipped", newVersion: 2 });
    if (!r.ok) return;
    expect(r.content).toContain("status: draft\nversion: 2\nimplementedIn: https://github.com/org/repo/pull/1\nshippedVersion: 1\nshippedRef: " + REF + "\n---\n");
    expect(r.content).not.toContain("ratifiedBy");
    expect(shippedRecordOf(parseSliceDoc(r.content))).toMatchObject({ version: 1, ratifiedRef: REF });
    // Without a ratifiedRef: shippedVersion only.
    const bare = applyReviseFrontmatter(SHIPPED_PRE);
    expect(bare.ok && bare.content).toContain("implementedIn: https://github.com/org/repo/pull/1\nshippedVersion: 1\n---\n");
    expect(bare.ok && bare.content).not.toContain("shippedRef");
  });

  it("unshipped (ratified, never shipped): version bumped, sign-off cleared, no shipped record invented", () => {
    const r = applyReviseFrontmatter(RATIFIED_UNSHIPPED);
    expect(r).toMatchObject({ ok: true, kind: "unshipped", newVersion: 2 });
    expect(r.ok && r.content).toBe("---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 2\n---\n" + BODY);
    expect(r.ok && shippedRecordOf(parseSliceDoc(r.content))).toBeNull();
  });

  it("legacy unsigned ready-to-implement: reopened as draft at the SAME version — the exit path", () => {
    const r = applyReviseFrontmatter(LEGACY_UNSIGNED);
    expect(r).toMatchObject({ ok: true, kind: "unsigned", newVersion: 2, reopened: 0 });
    expect(r.ok && r.content).toBe(LEGACY_UNSIGNED.replace("status: ready-to-implement", "status: draft"));
  });

  it("refuses draft/reviewed — the next version is already open", () => {
    const draft = SHIPPED_115.replace("status: implemented", "status: draft");
    expect(applyReviseFrontmatter(draft)).toEqual({
      ok: false,
      message: "doc is `status: draft` — the next version is already open over the shipped one; edit it, then `em slice review --by` and `em slice ratify --by` when it is ready",
    });
    const reviewed = RATIFIED_UNSHIPPED.replace("status: ready-to-implement", "status: reviewed");
    expect(applyReviseFrontmatter(reviewed)).toMatchObject({ ok: false, message: expect.stringContaining("doc is `status: reviewed` — the next version is already open;") });
  });

  it("re-opens exactly the questions deferred to the new version", () => {
    const doc = SHIPPED_115 + "\n## Open Questions\n\n- [x] Retry policy? — v1: fail fast; deferred to v2 (2026-10-08, Alex)\n- [x] Audit? — v1: later; deferred to v3 (2026-10-08)\n";
    const r = applyReviseFrontmatter(doc);
    expect(r).toMatchObject({ ok: true, reopened: 1 });
    expect(r.ok && r.content).toContain("\n- [ ] Retry policy?\n- [x] Audit? — v1: later; deferred to v3 (2026-10-08)\n");
  });

  it("refuses with clear errors on a missing fence / status / version, and a non-integer version", () => {
    expect(applyReviseFrontmatter("no fence\n")).toEqual({ ok: false, message: "no frontmatter block found" });
    expect(applyReviseFrontmatter("---\nversion: 1\n---\n")).toEqual({ ok: false, message: "no `status:` field found in frontmatter" });
    expect(applyReviseFrontmatter("---\nstatus: implemented\n---\n")).toEqual({ ok: false, message: "no `version:` field found in frontmatter" });
    expect(applyReviseFrontmatter("---\nstatus: implemented\nversion: x\n---\n")).toMatchObject({ ok: false, message: expect.stringContaining("isn't a positive integer") });
  });

  it("keeps CRLF", () => {
    const crlf = SHIPPED_115.replace(/\n/g, "\r\n");
    const r = applyReviseFrontmatter(crlf);
    expect(r.ok && r.content).toContain("status: draft\r\nimplementedIn:");
    expect(r.ok && r.content).toContain("shippedOn: 2026-10-12\r\nversion: 2\r\n---\r\n");
    expect(r.ok && r.content).not.toMatch(/[^\r]\n/);
  });

  it("openNextDraft is the shipped transition, usable on an already-flipped doc (mark-implemented's auto-open)", () => {
    expect(openNextDraft(SHIPPED_115)).toEqual(applyReviseFrontmatter(SHIPPED_115));
  });
});

describe("runRevise (fs orchestration + MIL-214 advisory)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-revise-"));
    mkdirSync(join(dir, "slices"));
    mkdirSync(join(dir, "conformance"));
    writeFileSync(join(dir, "slices", "shipped-slice.md"), SHIPPED_115.replace("version: 1\n", "version: 1\nconformedVersion: 1\nconformedAt: abc\nconformedOn: 2026-10-13\n"));
    writeFileSync(join(dir, "shipped.em"), 'slice "Shipped Slice" {\n  command Do Thing note "slices/shipped-slice.md"\n  event Thing Done\n}\n');
    writeFileSync(join(dir, "slices", "uncertified.md"), SHIPPED_PRE);
    writeFileSync(join(dir, "uncertified.em"), 'slice "Uncertified" {\n  command Do Other note "slices/uncertified.md"\n  event Other Done\n}\n');
    writeFileSync(
      join(dir, "conformance", "2026-09-01-findings.json"),
      serializeFindingsDoc({
        findingsSchemaVersion: "1.0",
        model: "uncertified.em",
        report: "conformance/2026-09-01-report.md",
        revision: "abc",
        findings: [{ id: 1, surface: "structural", class: "Real drift", slice: "uncertified", evidence: "e1", locus: null, resolvedBy: null, resolvedOn: null }],
      }),
    );
    writeFileSync(join(dir, "unbound.em"), 'slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (file: string, key: string) => {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runRevise(model, refs, dir, key);
  };

  it("revises a certified shipped doc: draft v2, no advisory warnings, conformed* keys kept", () => {
    const r = run("shipped.em", "shipped-slice");
    expect(r).toMatchObject({ ok: true, kind: "shipped", newVersion: 2, advisory: { neverCertified: false, unruledFindingsCount: 0 } });
    const written = readFileSync(join(dir, "slices", "shipped-slice.md"), "utf8");
    expect(written).toContain("status: draft\n");
    expect(written).toContain("conformedVersion: 1\n");
    expect(written).toContain("shippedVersion: 1\n");
  });
  it("a second run refuses — the draft is already open", () => {
    expect(run("shipped.em", "shipped-slice")).toMatchObject({ ok: false, message: expect.stringContaining("the next version is already open over the shipped one") });
  });
  it("warns (advisory, never refuses) on an uncertified shipped version with unruled findings", () => {
    const r = run("uncertified.em", "uncertified");
    expect(r).toMatchObject({ ok: true, kind: "shipped", advisory: { neverCertified: true, unruledFindingsCount: 1 } });
  });
  it("errors clearly on an unknown key and an unbound slice", () => {
    expect(run("shipped.em", "nope")).toEqual({ ok: false, message: 'no slice with export key "nope" in this model' });
    expect(run("unbound.em", "unbound")).toMatchObject({ ok: false, message: expect.stringContaining("has no doc bound") });
  });
  it("reviseAdvisory compares against the shipped version", () => {
    expect(reviseAdvisory(dir, "x", 1, 1)).toMatchObject({ neverCertified: false });
    expect(reviseAdvisory(dir, "x", 2, 1)).toMatchObject({ neverCertified: true });
  });
});

describe("em slice revise / reratify (CLI)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-revise-cli-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "pay.md"), SHIPPED_115);
    writeFileSync(join(dir, "slices", "ship.md"), SHIPPED_115.replace("Shipped Slice", "Ship"));
    writeFileSync(join(dir, "model.em"), 'slice "Pay" {\n  command Pay note "slices/pay.md"\n  event Paid\n}\nslice "Ship" {\n  command Ship note "slices/ship.md"\n  event Shipped\n}\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("revise prints the transition and leaves v1 shipped", () => {
    const r = em(["slice", "revise", "model.em", "pay"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("revised: slices/pay.md (status: draft, version: 2 — v1 stays shipped; v2 opened as draft)\n");
    expect(readFileSync(join(dir, "slices", "pay.md"), "utf8")).toContain("status: draft\n");
  });
  it("reratify is the deprecated alias: same effect, a notice on stderr, flags ignored with a notice", () => {
    const r = em(["slice", "reratify", "model.em", "ship", "--meaning-unchanged"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("notice: `em slice reratify` is deprecated since 1.15.0");
    expect(r.stderr).toContain("--meaning-unchanged/--contract-change are not taken");
    expect(r.stdout).toContain("revised: slices/ship.md (status: draft, version: 2");
    expect(readFileSync(join(dir, "slices", "ship.md"), "utf8")).not.toContain("meaningConfirmed");
  });
});
