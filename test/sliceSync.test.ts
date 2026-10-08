// SPDX-License-Identifier: MIT
// Coverage for `em slice sync` (src/cli/sliceSync.ts, MIL-266): generated regions are rewritten
// in place from the model, authored bytes never move, --check never writes, docs without
// regions are skipped, CRLF survives, and the JSON report's shape.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { scanSliceRegions, buildSliceRegions } from "../src/catalog/sliceSections.js";
import { syncDocText } from "../src/cli/sliceSync.js";
import { buildSliceDocContent } from "../src/cli/sliceNew.js";

// CLI-spawning file: a cold CI runner takes ~5–6 s per spawn (briefing §5, MIL-205 pattern).
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const MULTI = join(ROOT, "examples", "multi-model");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The doc's text with every region interior blanked out — what must never change. */
function authoredOnly(text: string): string[] {
  const { regions, problems } = scanSliceRegions(text);
  expect(problems).toEqual([]);
  const parts: string[] = [];
  let at = 0;
  for (const r of regions) {
    parts.push(text.slice(at, r.innerStart));
    at = r.innerEnd;
  }
  parts.push(text.slice(at));
  return parts;
}

const MODEL = (field: string) =>
  [
    'slice "Pay" {',
    '  ui Pay Screen',
    `  command Pay Order note "slices/pay.md" {`,
    "    amount: decimal",
    `    ${field}: string`,
    "  }",
    '  invariant INV-PAY-1 "Amount must be positive"',
    "  event Order Paid {",
    "    amount: decimal",
    "  }",
    "}",
    'slice "Paid" {',
    '  view Paid Orders from "Order Paid"',
    "  ui Paid Screen",
    "}",
  ].join("\n");

const AUTHORED_EDITS: Array<[string, string]> = [
  ["{{Why this slice exists — the user or business goal it serves, in one or two sentences. Note the\noriginating ticket/conversation link here if one exists.}}", "Customers pay for an order.\n\nTwo paragraphs, *authored*."],
  ["- [ ] {{question}}", "- [x] Settled: cards only"],
];

function writeDocFor(dir: string, field: string): string {
  const { model } = compile(MODEL(field));
  let doc = buildSliceDocContent("Pay", "pay", "state-change", "Customer → Payment", buildSliceRegions(model, [0]));
  for (const [a, b] of AUTHORED_EDITS) doc = doc.replace(a, b);
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "slices", "pay.md"), doc);
  return doc;
}

describe("syncDocText (pure)", () => {
  it("is ok when every region is current, and returns the text unchanged", () => {
    const { model } = compile(MODEL("couponCode"));
    const doc = buildSliceDocContent("Pay", "pay", "state-change", "A → B", buildSliceRegions(model, [0]));
    const r = syncDocText(doc, buildSliceRegions(model, [0]));
    expect(r.status).toBe("ok");
    expect(r.next).toBe(doc);
    expect(r.regions.map((x) => x.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("reports orphan and missing regions without touching them", () => {
    const { model } = compile(MODEL("couponCode"));
    const doc = [
      "<!-- GENERATED:em-slice-event-gone:start -->",
      "old",
      "<!-- GENERATED:em-slice-event-gone:end -->",
      "<!-- GENERATED:em-slice-command:start -->",
      "<!-- GENERATED:em-slice-command:end -->",
      "",
    ].join("\n");
    const r = syncDocText(doc, buildSliceRegions(model, [0]));
    expect(r.regions).toEqual([
      { name: "em-slice-event-gone", status: "orphan" },
      { name: "em-slice-command", status: "stale" },
      { name: "em-slice-event", status: "missing" },
      { name: "em-slice-view", status: "missing" },
      { name: "em-slice-invariants", status: "missing" },
    ]);
    expect(r.next.startsWith("<!-- GENERATED:em-slice-event-gone:start -->\nold\n")).toBe(true);
    expect(r.next).toContain("<!-- GENERATED:em-slice-command:start -->\n**Command:** `Pay Order`\n");
  });

  it("keeps CRLF line endings, inside and outside the regions", () => {
    const { model } = compile(MODEL("couponCode"));
    const lf = buildSliceDocContent("Pay", "pay", "state-change", "A → B", buildSliceRegions(compile(MODEL("voucherCode")).model, [0]));
    const crlf = lf.replace(/\n/g, "\r\n");
    const r = syncDocText(crlf, buildSliceRegions(model, [0]));
    expect(r.status).toBe("stale");
    expect(r.next).not.toMatch(/[^\r]\n/);
    expect(r.next).toContain("| couponCode | string | yes | — |\r\n");
    expect(authoredOnly(r.next)).toEqual(authoredOnly(crlf));
  });

  it("is malformed (and rewrites nothing) when markers are unbalanced; no-regions on a marker-less doc", () => {
    const { model } = compile(MODEL("couponCode"));
    const bad = "<!-- GENERATED:em-slice-command:start -->\nx\n";
    expect(syncDocText(bad, buildSliceRegions(model, [0]))).toEqual({
      status: "malformed",
      regions: [],
      problems: ['region "em-slice-command" has no end marker'],
      next: bad,
    });
    expect(syncDocText("# 1.13 doc\n", buildSliceRegions(model, [0])).status).toBe("no-regions");
  });
});

describe("em slice sync (CLI)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slice-sync-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("renaming a command field in the .em changes only that table; authored bytes are identical", () => {
    const before = writeDocFor(dir, "couponCode");
    writeFileSync(join(dir, "m.em"), MODEL("voucherCode"));

    const check = em(["slice", "sync", "m.em", "--check"], dir);
    expect(check.status).toBe(1);
    expect(check.stdout).toBe("stale: slices/pay.md (em-slice-command)\n");
    expect(readFileSync(join(dir, "slices", "pay.md"), "utf8")).toBe(before); // --check never writes

    const r = em(["slice", "sync", "m.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("synced: slices/pay.md (em-slice-command)\n");
    const after = readFileSync(join(dir, "slices", "pay.md"), "utf8");
    expect(authoredOnly(after)).toEqual(authoredOnly(before));
    const changed = before.split("\n").filter((l, i) => after.split("\n")[i] !== l);
    expect(changed).toEqual(["| couponCode | string | yes | — |"]);
    expect(after).toContain("| voucherCode | string | yes | — |");

    const again = em(["slice", "sync", "m.em", "--check"], dir);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe("ok: slices/pay.md\n");
  });

  it("skips a doc without regions with a note (write) / no-regions (check), leaving it byte-identical", () => {
    writeFileSync(join(dir, "m.em"), MODEL("couponCode"));
    mkdirSync(join(dir, "slices"));
    const doc = "---\nschemaVersion: 1\npattern: state-change\nswimlane: x\nstatus: draft\nversion: 1\n---\n# Slice: Pay\n\nfree prose\n";
    writeFileSync(join(dir, "slices", "pay.md"), doc);
    const r = em(["slice", "sync", "m.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("note: slices/pay.md has no generated regions — re-create with em slice new --force to adopt them\n");
    const c = em(["slice", "sync", "m.em", "--check"], dir);
    expect(c.status).toBe(0);
    expect(c.stdout).toBe("no-regions: slices/pay.md\n");
    expect(readFileSync(join(dir, "slices", "pay.md"), "utf8")).toBe(doc);
  });

  it("--json: the sliceSyncSchemaVersion 1.0 report", () => {
    writeDocFor(dir, "couponCode");
    writeFileSync(join(dir, "m.em"), MODEL("voucherCode"));
    const r = em(["slice", "sync", "m.em", "pay", "--check", "--json"], dir);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toEqual({
      sliceSyncSchemaVersion: "1.0",
      generator: { name: "@milehimikey/em", version: expect.any(String) },
      file: "m.em",
      docs: [
        {
          key: "pay",
          path: "slices/pay.md",
          status: "stale",
          regions: [
            { name: "em-slice-command", status: "stale" },
            { name: "em-slice-event", status: "ok" },
            { name: "em-slice-view", status: "ok" },
            { name: "em-slice-invariants", status: "ok" },
          ],
        },
      ],
    });
  });

  it("refuses an unknown key and an unbound slice with exact messages", () => {
    writeDocFor(dir, "couponCode");
    writeFileSync(join(dir, "m.em"), MODEL("couponCode"));
    const unknown = em(["slice", "sync", "m.em", "nope"], dir);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toBe('em slice sync: no slice with export key "nope" in this model\n');
    const unbound = em(["slice", "sync", "m.em", "paid"], dir);
    expect(unbound.status).toBe(1);
    expect(unbound.stderr).toBe('em slice sync: slice "paid" has no doc bound via `note "slices/paid.md"` — nothing to sync\n');
  });

  it("exits 1 on a malformed doc and names the problem", () => {
    writeFileSync(join(dir, "m.em"), MODEL("couponCode"));
    mkdirSync(join(dir, "slices"));
    writeFileSync(
      join(dir, "slices", "pay.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: x\nstatus: draft\nversion: 1\n---\n<!-- GENERATED:em-slice-command:start -->\n",
    );
    const r = em(["slice", "sync", "m.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('malformed: slices/pay.md (region "em-slice-command" has no end marker) — nothing in it was rewritten\n');
  });

  it("em validate warns on a malformed scenario (exit 0); --slice-ready blocks on it (exit 1)", () => {
    writeFileSync(join(dir, "m.em"), MODEL("couponCode"));
    const { model } = compile(MODEL("couponCode"));
    const doc = buildSliceDocContent("Pay", "pay", "state-change", "A → B", buildSliceRegions(model, [0]))
      .replace("status: draft\nversion: 1\n", "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n")
      .replace("- [ ] {{question}}", "- [x] settled")
      .replace("- **Then:**\n  - {{event(s) recorded}}\n  - {{resulting read-model change}}\n", "");
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "pay.md"), doc);
    const plain = em(["validate", "m.em"], dir);
    expect(plain.status).toBe(0);
    expect(plain.stderr).toContain(
      'slice doc "slices/pay.md" (slice "pay"): scenario "Happy path" has no **Then:** — every `### Scenario:` block needs Given, When and Then bullets',
    );
    const gate = em(["validate", "m.em", "--slice-ready", "pay"], dir);
    expect(gate.status).toBe(1);
    expect(gate.stdout).toBe('slice "pay" is NOT ready-to-implement\n');
    // Only the optIn twin (error, refs [key]) is scoped to the slice; the plain warning carries no ref.
    expect(gate.stderr).toBe(
      '  error:1 slice "pay"\'s doc slices/pay.md: scenario "Happy path" has no **Then:** — every `### Scenario:` block needs Given, When and Then bullets\n',
    );
  });

  it("regenerating every example slice doc produces no diff at all", () => {
    cpSync(MULTI, dir, { recursive: true });
    const docs = (m: string) => readdirSync(join(dir, "models", m, "slices")).map((f) => join(dir, "models", m, "slices", f));
    const all = [...docs("checkout"), ...docs("fulfillment")];
    expect(all.length).toBeGreaterThan(0);
    const before = all.map((p) => readFileSync(p, "utf8"));
    for (const m of ["checkout", "fulfillment"]) {
      const r = em(["slice", "sync", `models/${m}/${m}.em`], dir);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/^ok: slices\//);
    }
    expect(all.map((p) => readFileSync(p, "utf8"))).toEqual(before);
  });
});
