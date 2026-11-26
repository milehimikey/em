// SPDX-License-Identifier: MIT
// GH #539: `em slice mark-implemented --unit` — one pull request URL per work unit, the doc
// flipped only when every unit has one.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";
import { createMultiRepoProject, MultiRepoProject, readyDoc } from "./helpers/multiRepoProject.js";
import { applyUnitImplemented, formatUnitLinks, parseUnitLinks } from "../src/cli/markImplemented.js";
import { matchImplementedInToPaths } from "../src/cli/conformScope.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const WEB = "https://github.com/acme/web/pull/12";
const ORDERS = "https://github.com/acme/orders/pull/31?diff=split";
const MAP = `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web, root: src/checkout}\n`;

describe("parseUnitLinks / formatUnitLinks", () => {
  it("round-trips <repo>=<url> pairs in repo-id order; a URL may contain =", () => {
    const value = formatUnitLinks([{ repo: "web", url: WEB }, { repo: "orders", url: ORDERS }]);
    expect(value).toBe(`orders=${ORDERS},web=${WEB}`);
    expect(parseUnitLinks(value)).toEqual([{ repo: "orders", url: ORDERS }, { repo: "web", url: WEB }]);
  });
  it("a plain URL, a path or nothing is not a unit list", () => {
    for (const v of [WEB, "src/checkout", null, "web=", "web=a,web=b"]) expect(parseUnitLinks(v)).toBeNull();
  });
  it("conform-scope never reads a unit list as a path", () => {
    expect(matchImplementedInToPaths(`orders=${ORDERS},web=${WEB}`, ["orders=https:", "src/x"])).toEqual([]);
  });
});

describe("applyUnitImplemented (pure)", () => {
  const raw = readyDoc("place-order", "state-change");
  it("records the first unit without flipping, then flips on the last", () => {
    const first = applyUnitImplemented(raw, "web", WEB, ["web", "orders"], "2026-11-26");
    expect(first).toMatchObject({ ok: true, changed: true, complete: false, waiting: ["orders"] });
    if (!first.ok) return;
    expect(first.content).toContain("status: ready-to-implement\nimplementedInPending: web=" + WEB);
    expect(first.content).not.toContain("implementedIn:");
    expect(first.content).not.toContain("shippedVersion");
    const second = applyUnitImplemented(first.content, "orders", ORDERS, ["web", "orders"], "2026-11-26");
    expect(second).toMatchObject({ ok: true, changed: true, complete: true, waiting: [] });
    if (!second.ok) return;
    expect(second.content).toContain(`status: implemented\nimplementedIn: orders=${ORDERS},web=${WEB}`);
    expect(second.content).not.toContain("implementedInPending");
    expect(second.content).toContain("shippedVersion: 1");
    expect(second.content).toContain("shippedOn: 2026-11-26");
    // Re-running either unit afterwards is a no-op.
    expect(applyUnitImplemented(second.content, "web", WEB, ["web", "orders"])).toMatchObject({ ok: true, changed: false, complete: true });
  });
  it("is a no-op on the same URL and refuses a different one for a recorded unit", () => {
    const first = applyUnitImplemented(raw, "web", WEB, ["web", "orders"]);
    if (!first.ok) throw new Error("setup");
    expect(applyUnitImplemented(first.content, "web", WEB, ["web", "orders"])).toMatchObject({ ok: true, changed: false, complete: false, waiting: ["orders"] });
    const other = applyUnitImplemented(first.content, "web", "https://github.com/acme/web/pull/99", ["web", "orders"]);
    expect(!other.ok && other.message).toContain('unit "web" is already recorded with a different URL');
  });
  it("the next version of a shipped slice is recorded afresh: the previous version's links neither block nor ship it", () => {
    const v1 = `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 2\nratifiedBy: Alex Rivera\nimplementedIn: orders=${ORDERS},web=${WEB}\nshippedVersion: 1\nshippedOn: 2026-11-01\n---\n# Slice\n\n## Open Questions\n- [x] resolved\n`;
    const NEW_ORDERS = "https://github.com/acme/orders/pull/77";
    const NEW_WEB = "https://github.com/acme/web/pull/55";
    // A new URL for a unit is recorded, not refused as "a different URL".
    const first = applyUnitImplemented(v1, "orders", NEW_ORDERS, ["web", "orders"], "2026-11-26");
    expect(first).toMatchObject({ ok: true, changed: true, complete: false, waiting: ["web"] });
    if (!first.ok) return;
    // v1's record is still what `implementedIn:` says while v2 is being built.
    expect(first.content).toContain(`implementedIn: orders=${ORDERS},web=${WEB}\nimplementedInPending: orders=${NEW_ORDERS}`);
    expect(first.content).toContain("status: ready-to-implement");
    expect(first.content).toContain("shippedVersion: 1");
    // Re-sending a v1 URL does not complete v2 on stale links.
    const stale = applyUnitImplemented(v1, "web", WEB, ["web", "orders"]);
    expect(stale).toMatchObject({ ok: true, complete: false, waiting: ["orders"] });
    const second = applyUnitImplemented(first.content, "web", NEW_WEB, ["web", "orders"], "2026-11-26");
    expect(second).toMatchObject({ ok: true, complete: true });
    if (!second.ok) return;
    expect(second.content).toContain(`implementedIn: orders=${NEW_ORDERS},web=${NEW_WEB}`);
    expect(second.content).toContain("shippedVersion: 2");
    expect(second.content).not.toContain("implementedInPending");
    expect(second.content).not.toContain(ORDERS);
  });

  it("keeps a CRLF doc CRLF, pending line included", () => {
    const crlf = raw.replace(/\n/g, "\r\n");
    const first = applyUnitImplemented(crlf, "web", WEB, ["web", "orders"]);
    if (!first.ok) throw new Error("setup");
    expect(first.content).toContain("status: ready-to-implement\r\nimplementedInPending: web=" + WEB + "\r\n");
    expect(first.content.replace(/\r\n/g, "")).not.toContain("\n");
    const second = applyUnitImplemented(first.content, "orders", ORDERS, ["web", "orders"], "2026-11-26");
    expect(second.ok && second.content.replace(/\r\n/g, "")).not.toContain("\n");
    expect(second.ok && second.content).not.toContain("implementedInPending");
  });

  it("refuses a URL with a comma or whitespace, and a doc that is not ratified", () => {
    expect(applyUnitImplemented(raw, "web", "https://x/a,b", ["web", "orders"]).ok).toBe(false);
    const draft = raw.replace("status: ready-to-implement", "status: draft");
    const r = applyUnitImplemented(draft, "web", WEB, ["web"]);
    expect(!r.ok && r.message).toContain("mark-implemented applies only to a ratified");
  });
});

describe("em slice mark-implemented --unit (CLI, GH #539)", () => {
  let p: MultiRepoProject;
  const doc = (key: string) => readFileSync(join(p.modelDir, "slices", `${key}.md`), "utf8");
  const mark = (...args: string[]) => em(["slice", "mark-implemented", "shop.em", ...args], p.modelDir);

  beforeAll(() => {
    p = createMultiRepoProject(["web", "orders", "payments"], MAP);
  });
  afterAll(() => rmTemp(p.base));

  it("a slice with two units refuses a bare URL and names its units", () => {
    const r = mark("place-order", WEB);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('slice "place-order" has 2 work units (web, orders) — record each pull request with --unit <repo>');
    expect(doc("place-order")).toContain("status: ready-to-implement");
    const bad = mark("place-order", WEB, "--unit", "payments");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('has no work unit in repo "payments" — its units are in: web, orders');
  });

  it("layout 3: the doc flips only when both units are recorded", () => {
    const a = mark("place-order", WEB, "--unit", "web");
    expect(a.status).toBe(0);
    expect(a.stdout).toContain(`recorded: place-order@web (${WEB}) — 1 of 2 units; slices/place-order.md stays ready-to-implement until orders is recorded`);
    expect(doc("place-order")).toContain(`status: ready-to-implement\nimplementedInPending: web=${WEB}`);
    const json = JSON.parse(mark("place-order", ORDERS, "--unit", "orders", "--json").stdout);
    expect(json).toEqual({ path: "slices/place-order.md", changed: true, implementedIn: `orders=${ORDERS},web=${WEB}`, nextDraft: null, unit: "place-order@orders", complete: true, waiting: [] });
    expect(doc("place-order")).toContain(`status: implemented\nimplementedIn: orders=${ORDERS},web=${WEB}`);
    expect(doc("place-order")).toContain("shippedVersion: 1");
    expect(mark("place-order", WEB, "--unit", "web").stdout).toContain("already implemented (no-op)");
    // The shipped slice validates: the link list is a link, the record is coherent.
    expect(em(["validate", "shop.em"], p.modelDir).status).toBe(0);
  });

  it("a one-unit slice ships with one URL, with or without --unit", () => {
    expect(mark("open-orders", "https://github.com/acme/orders/pull/40", "--unit", "orders").status).toBe(0);
    expect(doc("open-orders")).toContain("status: implemented\nimplementedIn: https://github.com/acme/orders/pull/40");
  });

  it("no code map: --unit is refused and a bare URL works as it always did", () => {
    rmSync(join(p.modelDir, "code-map.yaml"));
    writeFileSync(join(p.modelDir, "slices", "cancel-order.md"), readyDoc("cancel-order", "state-change"));
    const r = mark("cancel-order", WEB, "--unit", "web");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the model has no code-map.yaml");
    const ok = mark("cancel-order", WEB);
    expect(ok.stdout).toContain(`marked implemented: slices/cancel-order.md (implementedIn: ${WEB})`);
  });
});
