// SPDX-License-Identifier: MIT
// GH #347 (owner ruling 2026-10-22: option A): `ratifiedHash` covers the authored text only, so a
// change in `em slice sync`'s OUTPUT no longer stales a ratified doc. The issue's repro, verbatim,
// through the real binary: a doc synced and ratified under 1.17 goes `stale` under 1.18+ (the
// "built from" line gains `again`-instance names, GH #280; a collection view gains `Collection of`
// rows plus `{{ }}` scenario stubs, GH #288); running `em slice sync` then used to make
// `em validate --check-signed-bodies` report the doc as edited after ratification. Now sync keeps
// (or, for an intact 1.17-scope hash, re-stamps) the signature, `em upgrade` lists and re-stamps
// 1.17-scope hashes, a genuine authored edit is still reported in every scope, and `em validate`
// reports an unresolved `{{ }}` placeholder inside a signed doc's generated region (the rider).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildSliceRegions, regionEndLine, regionStartLine } from "../src/catalog/sliceSections.js";
import { ratifiedHashScope, sliceDocBodyHash, sliceDocLegacyBodyHash, sliceDocV117BodyHash } from "../src/catalog/sliceDoc.js";
import { keepSignature } from "../src/cli/sliceSync.js";
import { writeModel117 } from "./helpers/model117.js";
import { rmTemp } from "./helpers/rmTemp.js";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (args: string[], cwd: string) => {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const hashOf = (text: string) => /ratifiedHash: (\S+)/.exec(text)![1];
const signWith = (plain: string, hash: string, ref = "") =>
  plain.replace("status: draft", `status: ready-to-implement\nratifiedBy: Alex\nratifiedOn: 2026-10-02\n${ref ? `ratifiedRef: ${ref}\n` : ""}ratifiedHash: ${hash}`);

describe("GH #347 repro (b): a ratified view doc whose 'built from' line gains `again` names (CLI, real git)", () => {
  let dir: string;
  let docPath: string;
  let plain: string;
  let ref: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh347-"));
    writeModel117(dir); // slices/orders.md as 1.17's sync wrote it: origin-only "built from" line
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "em test");
    git(dir, "config", "user.email", "em-test@example.com");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "1.17 model");
    ref = git(dir, "rev-parse", "HEAD").trim();
    docPath = join(dir, "slices", "orders.md");
    plain = readFileSync(docPath, "utf8");
  });
  afterEach(() => rmTemp(dir));

  const ratify = (hash: string) => {
    writeFileSync(docPath, signWith(plain, hash, ref));
    git(dir, "add", "slices/orders.md");
    git(dir, "commit", "-q", "-m", "ratify orders");
    return readFileSync(docPath, "utf8");
  };

  it("ratified under the 1.17 scope: sync --check reports stale, `em slice sync` rewrites it and --check-signed-bodies stays green (hash re-stamped, ratifiedRef untouched)", () => {
    const signed = ratify(sliceDocV117BodyHash(plain));
    // Repro: under 1.18+ the ratified view doc reports stale with no model or authored-text change.
    const check = em(["slice", "sync", "orders.em", "--check"], dir);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("stale: slices/orders.md (em-slice-view)");
    // The 1.17 scope is still recognised as intact before anything moves it.
    expect(em(["validate", "orders.em", "--check-signed-bodies"], dir).status).toBe(0);

    const sync = em(["slice", "sync", "orders.em"], dir);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stdout).toContain("synced: slices/orders.md (em-slice-view)");
    expect(sync.stderr).toContain(
      "note: slices/orders.md is signed — generated regions rewritten, ratifiedHash re-stamped from the 1.17 scope to the current scope (same authored text, not a re-signing; ratifiedRef untouched)",
    );
    const after = readFileSync(docPath, "utf8");
    expect(after).toContain('built from events: "Order Placed", "Order Placed Manually" (via "Orders manual")');
    expect(after).toContain(`ratifiedRef: ${ref}\n`);
    expect(hashOf(after)).toBe(sliceDocBodyHash(signed));
    // Expected: no longer reported as edited after ratification.
    const signedCheck = em(["validate", "orders.em", "--check-signed-bodies"], dir);
    expect(signedCheck.status, signedCheck.stdout + signedCheck.stderr).toBe(0);
    expect(signedCheck.stdout + signedCheck.stderr).not.toContain("slice-body-changed-since-ratification");
    expect(em(["validate", "orders.em", "--slice-ready", "orders"], dir).stdout).not.toContain("slice-ready-body-changed-since-ratification");
    expect(em(["slice", "sync", "orders.em", "--check"], dir).status).toBe(0);
  });

  it("ratified in the current scope: `em slice sync` keeps ratifiedHash byte-for-byte and says so", () => {
    const signed = ratify(sliceDocBodyHash(plain));
    const sync = em(["slice", "sync", "orders.em", "orders"], dir);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stderr).toContain("note: slices/orders.md is signed — generated regions rewritten, ratifiedHash kept (it covers the authored text only)");
    const after = readFileSync(docPath, "utf8");
    expect(after).not.toBe(signed);
    expect(hashOf(after)).toBe(hashOf(signed));
    expect(em(["validate", "orders.em", "--check-signed-bodies"], dir).status).toBe(0);
  });

  it("em upgrade (dry run) lists a 1.17-scope doc and writes nothing; --apply re-stamps it with the same body (ratifiedRef untouched); a second run is a no-op", () => {
    const signed = ratify(sliceDocV117BodyHash(plain));
    const dry = em(["upgrade", "orders.em"], dir);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      "[x] ratified-hash-scope (since 1.19.0): 1 doc(s) carry a 1.17–1.18 ratifiedHash (generated regions inside; body intact): orders — em upgrade will re-stamp them in the 1.19 scope (authored text only: generated regions and Open Questions deferrals excluded; same body, not a re-signing; ratifiedRef untouched)",
    );
    expect(git(dir, "status", "--porcelain")).toBe("");
    const applied = em(["upgrade", "orders.em", "--apply"], dir);
    expect(applied.status, applied.stderr).toBe(0);
    const after = readFileSync(docPath, "utf8");
    expect(after).toContain(`ratifiedRef: ${ref}\n`);
    expect(hashOf(after)).toBe(sliceDocBodyHash(signed));
    expect(em(["validate", "orders.em", "--check-signed-bodies"], dir).status).toBe(0);
    expect(em(["upgrade", "orders.em"], dir).stdout).toContain("[ ] ratified-hash-scope (since 1.19.0): every intact ratifiedHash is in the 1.19 scope");
  });

  for (const [scope, hashFn] of [
    ["current", sliceDocBodyHash],
    ["v1.17", sliceDocV117BodyHash],
    ["legacy", sliceDocLegacyBodyHash],
  ] as const) {
    it(`a genuine authored-text edit after ratification is still reported — hash recorded in the ${scope} scope; sync does not paper over it; upgrade leaves it alone`, () => {
      const signed = ratify(hashFn(plain));
      expect(ratifiedHashScope(signed, hashOf(signed))).toBe(scope);
      writeFileSync(docPath, signed.replace("# orders\n", "# orders, edited\n"));
      const v = em(["validate", "orders.em", "--check-signed-bodies"], dir);
      expect(v.status).toBe(1);
      expect(v.stdout + v.stderr).toContain("was edited after ratification — body no longer matches ratifiedHash");
      const sync = em(["slice", "sync", "orders.em"], dir);
      expect(sync.status, sync.stderr).toBe(0);
      expect(sync.stderr).toContain("note: slices/orders.md's body already failed its ratifiedHash before this sync (edited after ratification) — generated regions rewritten, nothing re-stamped");
      expect(hashOf(readFileSync(docPath, "utf8"))).toBe(hashOf(signed));
      expect(em(["validate", "orders.em", "--check-signed-bodies"], dir).status).toBe(1);
      git(dir, "commit", "-q", "-am", "edited");
      expect(em(["upgrade", "orders.em"], dir).stdout).toContain("left alone: orders — body no longer matches ratifiedHash in any scope");
    });
  }
});

// GH #288 shape: a collection view field; 1.17's sync wrote a plain "Derived" row.
const ATTRS = (valuesClause: string) => `model "Attrs"
context Catalog
persona Admin

type AttributeValue { valueId: string, value: string }

slice "Add Value" {
  ui Value Form @Admin
  command Add Value
  event Attribute Value Created @Catalog { attributeId: string, valueId: string, value: string }
}

slice "Remove Value" {
  ui Value List @Admin
  command Remove Value
  event Attribute Value Deleted @Catalog { attributeId: string, valueId: string }
}

slice "Attributes" {
  view Attributes from "Attribute Value Created", "Attribute Value Deleted" {
    attributeId: string
    values: AttributeValue[]${valuesClause}
  } note "slices/attributes.md"
  ui Attribute Screen @Admin
}
`;
const CURRENT = ATTRS(' derived from "Attribute Value Created", "Attribute Value Deleted"');

function attrsDoc(source: string, status: string): string {
  const { model } = compile(source);
  const regions = buildSliceRegions(model, [2])
    .map((r) => [regionStartLine(r.name), ...r.body, regionEndLine(r.name)].join("\n"))
    .join("\n\n");
  return (
    `---\nschemaVersion: 1\npattern: state-view\nswimlane: catalog\nstatus: ${status}\nversion: 1\n---\n# Attributes\n\n## Intent\n\nList attributes and their values.\n\n${regions}\n\n` +
    "## Scenarios\n\n### Scenario: a created value is listed\n- **Given:** `Attribute Value Created`\n- **When:** the Attributes view is queried\n- **Then:** `values` contains it\n"
  );
}

describe("GH #347 repro (a): a ratified collection view doc gains `Collection of` rows and `{{ }}` stubs (CLI)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh347-attrs-"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "attrs.em"), CURRENT);
  });
  afterEach(() => rmTemp(dir));

  it("`em slice sync` writes the stubs under the signature; --check-signed-bodies stays green; `em validate` reports the unresolved placeholders (rider)", () => {
    const plain = attrsDoc(ATTRS(" derived"), "draft"); // what a pre-#288 sync wrote
    const docPath = join(dir, "slices", "attributes.md");
    writeFileSync(docPath, signWith(plain, sliceDocV117BodyHash(plain)));
    expect(em(["validate", "attrs.em"], dir).stdout).not.toContain("unresolved {{ }} placeholder"); // nothing unresolved yet
    expect(em(["slice", "sync", "attrs.em", "--check"], dir).stdout).toContain("stale: slices/attributes.md (em-slice-view)");

    const sync = em(["slice", "sync", "attrs.em"], dir);
    expect(sync.status, sync.stderr).toBe(0);
    const after = readFileSync(docPath, "utf8");
    expect(after).toContain("Collection of `AttributeValue`, fed by `Attribute Value Created`, `Attribute Value Deleted`");
    expect(after).toContain("Scenario stubs for `values`");
    expect(em(["validate", "attrs.em", "--check-signed-bodies"], dir).status).toBe(0);

    // Rider: the stubs are unresolved placeholders inside the signed doc's generated region.
    const v = em(["validate", "attrs.em", "--json"], dir);
    const diags = (JSON.parse(v.stdout).diagnostics as Array<{ code: string; severity: string; message: string; refs?: string[] }>).filter(
      (d) => d.code === "slice-doc/generated-region-placeholder",
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain('slice doc "slices/attributes.md" (slice "attributes", status: ready-to-implement): generated region "em-slice-view" holds');
    expect(diags[0].message).toContain("unresolved {{ }} placeholder(s)");
    expect(diags[0].refs).toEqual(["attributes"]);
  });

  it("rider: a draft doc's placeholders are not reported (it is still being written); a shipped doc's are", () => {
    const docPath = join(dir, "slices", "attributes.md");
    writeFileSync(docPath, attrsDoc(CURRENT, "draft"));
    const draft = em(["validate", "attrs.em"], dir);
    expect(draft.stdout + draft.stderr).not.toContain("unresolved {{ }} placeholder");
    writeFileSync(docPath, attrsDoc(CURRENT, "implemented"));
    const out = em(["validate", "attrs.em"], dir);
    expect(out.stdout + out.stderr).toContain("generated region \"em-slice-view\" holds 6 unresolved {{ }} placeholder(s)");
  });
});

describe("keepSignature (pure, GH #347)", () => {
  const doc = (hash: string, row: string, body = "# S\n") =>
    `---\nstatus: implemented\nversion: 1\nratifiedHash: ${hash}\n---\n${body}\n${regionStartLine("em-slice-view")}\n${row}\n${regionEndLine("em-slice-view")}\n`;
  it("no hash → passes through; current → kept; v1.17/legacy → re-stamped; mismatch → broken, untouched", () => {
    expect(keepSignature("---\nstatus: draft\n---\nx\n", "y")).toEqual({ ok: true, content: "y", signature: null });
    const cur = sliceDocBodyHash(doc("x", "old"));
    expect(keepSignature(doc(cur, "old"), doc(cur, "new"))).toEqual({ ok: true, content: doc(cur, "new"), signature: { kind: "kept" } });
    const v117 = sliceDocV117BodyHash(doc("x", "old"));
    expect(keepSignature(doc(v117, "old"), doc(v117, "new"))).toEqual({ ok: true, content: doc(cur, "new"), signature: { kind: "restamped", from: "v1.17" } });
    const legacy = sliceDocLegacyBodyHash(doc("x", "old"));
    expect(keepSignature(doc(legacy, "old"), doc(legacy, "new"))).toEqual({ ok: true, content: doc(cur, "new"), signature: { kind: "restamped", from: "legacy" } });
    const edited = doc(cur, "old", "# S, edited\n");
    expect(keepSignature(edited, edited.replace("old", "new"))).toEqual({ ok: true, content: edited.replace("old", "new"), signature: { kind: "broken" } });
  });
});
