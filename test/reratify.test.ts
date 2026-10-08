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

  it("clears reviewedBy/reviewedOn alongside ratifiedBy/ratifiedOn (MIL-201)", () => {
    const withReview = IMPLEMENTED_DOC.replace(
      "ratifiedBy: Alex Rivera\n",
      "reviewedBy: Sam Okafor\nreviewedOn: 2026-07-20\nratifiedBy: Alex Rivera\n",
    );
    const result = applyReratifyFrontmatter(withReview);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain("reviewedBy:");
    expect(result.content).not.toContain("reviewedOn:");
    expect(result.content).not.toContain("ratifiedBy:");
    expect(result.content).not.toContain("ratifiedOn:");
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("version: 2");
    // Everything else survives byte-for-byte.
    const bodyMarker = "# Slice: Shipped Slice";
    expect(result.content.slice(result.content.indexOf(bodyMarker))).toBe(
      withReview.slice(withReview.indexOf(bodyMarker)),
    );
  });

  it("bumps cleanly when only reviewedBy/reviewedOn are present (never ratified through the command)", () => {
    const reviewOnly = IMPLEMENTED_DOC.replace(
      "ratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\n",
      "reviewedBy: Sam Okafor\nreviewedOn: 2026-07-20\n",
    );
    const result = applyReratifyFrontmatter(reviewOnly);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newVersion).toBe(2);
    expect(result.content).not.toContain("reviewedBy:");
    expect(result.content).not.toContain("reviewedOn:");
  });

  it("refuses a doc that's still draft — nothing has shipped yet to re-ratify", () => {
    const draft =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n";
    const result = applyReratifyFrontmatter(draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("status: draft");
    expect(result.message).toContain("can simply be edited");
  });

  it("refuses a doc that's reviewed — not ratified, so it can simply be edited (MIL-258)", () => {
    const reviewed =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\nratifiedBy: Pat\n---\nbody\n";
    const result = applyReratifyFrontmatter(reviewed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("status: reviewed");
  });

  it("refuses a doc already ready-to-implement — a bump here would silently double-increment", () => {
    const alreadyReratified =
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 2\n---\nbody\n";
    const result = applyReratifyFrontmatter(alreadyReratified);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("status: ready-to-implement");
    expect(result.message).toContain("awaiting ratification");
    expect(result.message).toContain("em slice ratify --by");
  });

  const UNSHIPPED_DOC =
    "---\n" +
    "schemaVersion: 1\n" +
    "pattern: state-change\n" +
    "swimlane: order\n" +
    "status: ready-to-implement\n" +
    "version: 1\n" +
    "reviewedBy: Sam Okafor\n" +
    "reviewedOn: 2026-09-28\n" +
    "ratifiedBy: Pat\n" +
    "ratifiedOn: 2026-10-01\n" +
    "---\n" +
    "# Slice: Place Order\n\nbody\n";

  it("MIL-258: accepts a ratified ready-to-implement doc — bumps version, clears sign-off, leaves status", () => {
    const result = applyReratifyFrontmatter(UNSHIPPED_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("unshipped");
    expect(result.newVersion).toBe(2);
    expect(result.content).toBe(
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 2\n---\n" +
        "# Slice: Place Order\n\nbody\n",
    );
    // No implementedIn was invented.
    expect(result.content).not.toContain("implementedIn:");
  });

  it("MIL-258: the state the unshipped path leaves behind refuses a second bump", () => {
    const first = applyReratifyFrontmatter(UNSHIPPED_DOC);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyReratifyFrontmatter(first.content);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain("awaiting ratification");
  });

  it("MIL-258: the shipped path reports kind: shipped", () => {
    const result = applyReratifyFrontmatter(IMPLEMENTED_DOC);
    expect(result.ok && result.kind).toBe("shipped");
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
    // MIL-214: the fixture doc has no conformedVersion at all (never certified), and there's no
    // conformance/ directory beside the model — so the advisory reports neverCertified: true,
    // unruledFindingsCount: 0.
    expect(result).toEqual({
      ok: true,
      path: "slices/shipped-slice.md",
      newVersion: 2,
      kind: "shipped",
      advisory: { neverCertified: true, unruledFindingsCount: 0 },
      reopened: 0,
    });
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
    expect(result).toEqual({
      ok: true,
      path: "slices/covering-slice.md",
      newVersion: 2,
      kind: "shipped",
      advisory: { neverCertified: true, unruledFindingsCount: 0 },
      reopened: 0,
    });
    const written = readFileSync(join(dir, "slices", "covering-slice.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("version: 2");
  });
});

describe("reratifyAdvisory / runReratify's MIL-214 certification advisory", () => {
  let dir: string;
  const CERTIFIED_DOC =
    "---\n" +
    "schemaVersion: 1\n" +
    "pattern: state-change\n" +
    "swimlane: order\n" +
    "status: implemented\n" +
    "version: 1\n" +
    "implementedIn: https://github.com/org/repo/pull/9\n" +
    "conformedVersion: 1\n" +
    "conformedAt: 8f12ed8\n" +
    "conformedOn: 2026-08-15\n" +
    "---\n" +
    "body\n";
  const UNCERTIFIED_DOC = CERTIFIED_DOC.replace(
    "conformedVersion: 1\nconformedAt: 8f12ed8\nconformedOn: 2026-08-15\n",
    "",
  );

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-reratify-advisory-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(join(dir, "slices", "certified-slice.md"), CERTIFIED_DOC);
    writeFileSync(
      join(dir, "certified.em"),
      'slice "Certified Slice" {\n  command Do Thing note "slices/certified-slice.md"\n  event Thing Done\n}\n',
    );
    writeFileSync(
      join(dir, "slices", "unshipped-slice.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n" +
        "ratifiedBy: Pat\nratifiedOn: 2026-10-01\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "unshipped.em"),
      'slice "Unshipped Slice" {\n  command Do Third note "slices/unshipped-slice.md"\n  event Third Done\n}\n',
    );
    writeFileSync(join(dir, "slices", "unruled-slice.md"), UNCERTIFIED_DOC);
    writeFileSync(
      join(dir, "unruled.em"),
      'slice "Unruled Slice" {\n  command Do Other note "slices/unruled-slice.md"\n  event Other Done\n}\n',
    );
    writeFileSync(
      join(dir, "conformance", "2026-08-20-findings.json"),
      JSON.stringify(
        {
          findingsSchemaVersion: "1.0",
          model: "unruled.em",
          report: "conformance/2026-08-20-report.md",
          revision: "8f12ed8",
          findings: [
            {
              id: 1,
              surface: "structural",
              class: "Real drift",
              slice: "unruled-slice",
              evidence: "code shows X",
              locus: null,
              resolvedBy: null,
              resolvedOn: null,
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(file: string, sliceKey: string) {
    const { model, refs } = compile(readFileSync(join(dir, file), "utf8"));
    return runReratify(model, refs, dir, sliceKey);
  }

  it("neverCertified: false when the current version was certified and has no unruled findings", () => {
    const result = run("certified.em", "certified-slice");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.advisory).toEqual({ neverCertified: false, unruledFindingsCount: 0 });
  });

  it("reports both neverCertified and unruledFindingsCount when a slice has an outstanding finding", () => {
    const result = run("unruled.em", "unruled-slice");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.advisory).toEqual({ neverCertified: true, unruledFindingsCount: 1 });
  });

  it("MIL-258: an unshipped (ratified ready-to-implement) doc carries no advisory — no 'never certified' claim", () => {
    const result = run("unshipped.em", "unshipped-slice");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("unshipped");
    expect(result.advisory).toBeNull();
    expect(readFileSync(join(dir, "slices", "unshipped-slice.md"), "utf8")).toContain("version: 2");
  });
});

// MIL-238 — the API-first meaning confirmation on a re-ratification.
describe("applyReratifyFrontmatter — meaning confirmation (MIL-238)", () => {
  it("clears the prior version's meaningConfirmed/contractChange with the sign-off keys", () => {
    const doc = IMPLEMENTED_DOC.replace("ratifiedOn: 2026-08-01\n", 'ratifiedOn: 2026-08-01\ncontractChange: "old reason"\nmeaningConfirmed: true\n');
    const result = applyReratifyFrontmatter(doc);
    expect(result.ok && result.content).toBe(
      IMPLEMENTED_DOC.replace("status: implemented", "status: ready-to-implement")
        .replace("version: 1", "version: 2")
        .replace("ratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\n", ""),
    );
  });

  it("writes the new confirmation directly after the bumped version line", () => {
    const doc = IMPLEMENTED_DOC.replace("ratifiedOn: 2026-08-01\n", "ratifiedOn: 2026-08-01\nmeaningConfirmed: true\n");
    const result = applyReratifyFrontmatter(doc, { kind: "contract-change", why: "status values renamed" });
    expect(result.ok && result.content).toBe(
      IMPLEMENTED_DOC.replace("status: implemented", "status: ready-to-implement")
        .replace("version: 1\n", 'version: 2\ncontractChange: "status values renamed"\n')
        .replace("ratifiedBy: Alex Rivera\nratifiedOn: 2026-08-01\n", ""),
    );
  });

  it("keeps CRLF line endings for the inserted line", () => {
    const crlf = IMPLEMENTED_DOC.replace(/\n/g, "\r\n");
    const result = applyReratifyFrontmatter(crlf, { kind: "meaning-unchanged" });
    expect(result.ok && result.content).toContain("version: 2\r\nmeaningConfirmed: true\r\n");
  });
});

describe("runReratify — public-touching slices (MIL-238)", () => {
  let dir: string;
  const MODEL =
    'slice "Place Order" {\n  command Place Order note "slices/place-order.md"\n  event Order Placed public { orderId: uuid }\n}\n' +
    'slice "Audit" {\n  command Record Audit note "slices/audit.md"\n  event Audit Recorded\n}\n';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-reratify-public-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "place-order.md"), IMPLEMENTED_DOC);
    writeFileSync(join(dir, "slices", "audit.md"), IMPLEMENTED_DOC);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(key: string, confirmation: Parameters<typeof runReratify>[4] = null) {
    const { model, refs } = compile(MODEL);
    return runReratify(model, refs, dir, key, confirmation);
  }

  it("refuses a public-touching slice without a confirmation — exact message, nothing written", () => {
    expect(run("place-order")).toEqual({
      ok: false,
      message:
        'slice "place-order" touches the public surface — pass --meaning-unchanged, or --contract-change "<why>" if a consumer must read this change differently',
    });
    expect(readFileSync(join(dir, "slices", "place-order.md"), "utf8")).toBe(IMPLEMENTED_DOC);
  });

  it("accepts --meaning-unchanged and records it on the new version", () => {
    expect(run("place-order", { kind: "meaning-unchanged" })).toMatchObject({ ok: true, newVersion: 2, kind: "shipped" });
    expect(readFileSync(join(dir, "slices", "place-order.md"), "utf8")).toContain("version: 2\nmeaningConfirmed: true\n");
  });

  it("reratifies a non-public slice without a flag", () => {
    expect(run("audit")).toMatchObject({ ok: true, newVersion: 2 });
    expect(readFileSync(join(dir, "slices", "audit.md"), "utf8")).not.toContain("meaningConfirmed");
  });

  it("reports the doc's own precondition before the confirmation requirement", () => {
    writeFileSync(join(dir, "slices", "place-order.md"), IMPLEMENTED_DOC.replace("status: implemented", "status: draft"));
    const result = run("place-order");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/^slices\/place-order\.md: doc is `status: draft`/);
  });
});

describe("reratify re-opens deferred questions (MIL-275)", () => {
  it("rewrites deferred-to-new-version items to unchecked; leaves later deferrals alone", async () => {
    const { reopenDeferred } = await import("../src/cli/defer.js");
    const doc =
      "## Open Questions\n\n- [x] A? — v1: fast; deferred to v2 (2026-10-08, Al)\n- [x] B? — v1: fast; deferred to v3 (2026-10-08)\n- [x] plain\n";
    const r = reopenDeferred(doc, 2);
    expect(r.count).toBe(1);
    expect(r.content).toBe(
      "## Open Questions\n\n- [ ] A?\n- [x] B? — v1: fast; deferred to v3 (2026-10-08)\n- [x] plain\n",
    );
  });
});
