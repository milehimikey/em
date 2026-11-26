// SPDX-License-Identifier: MIT
// GH #533: `em conform-scope`, `em freshness` and `em status` for a model whose code is in
// several repositories — each repo compared at its own recorded revision — with real git repos.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const em = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const git = (args: string[], cwd: string) => spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const commit = (cwd: string, msg: string): string => {
  git(["add", "-A"], cwd);
  git(["commit", "-qm", msg], cwd);
  return git(["rev-parse", "--short", "HEAD"], cwd).stdout.trim();
};

const MODEL = `model "Shop"
slice "Place Order" {
  ui Checkout @Customer
  command Place Order note "slices/place-order.md"
  event Order Placed @Orders
}
slice "Open Orders" {
  view Open Orders from "Order Placed" note "slices/open-orders.md"
  ui Order List @Staff
}
`;
const DOC = (pattern: string) => `---\nschemaVersion: 1\npattern: ${pattern}\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n## Intent\n`;
const SYSTEM = `systemSchemaVersion: "2.1"\nrepos:\n  web: {remote: "git@github.com:acme/web.git"}\n  orders: {remote: "git@github.com:acme/orders.git"}\nmodels:\n  shop: {source: shop/shop.em}\n`;
const MAP = `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\npersonas:\n  Customer: {repo: web}\n`;
const BIND_PLACE = `bindingsSchemaVersion: "1.1"\nslice: place-order\nelements:\n  - {ref: ui.checkout, repo: web, file: src/Checkout.tsx, identifier: CheckoutPage}\n  - {ref: command.place-order, repo: orders, file: src/Handler.kt, identifier: placeOrder}\n`;
const BIND_OPEN = `bindingsSchemaVersion: "1.0"\nslice: open-orders\nelements:\n  - {ref: view.open-orders, file: src/OpenOrders.kt, identifier: OpenOrders}\n`;

describe("conformance across repositories (GH #533)", () => {
  let base: string;
  let modelRepo: string;
  let dir: string;
  let web0: string;
  let orders0: string;
  let recorded: string;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "em-conform-repos-")));
    modelRepo = join(base, "model");
    for (const r of ["model", "web", "orders"]) {
      mkdirSync(join(base, r), { recursive: true });
      gitInitQuiet(join(base, r), "-b", "main");
    }
    mkdirSync(join(base, "web", "src"));
    writeFileSync(join(base, "web", "src", "Checkout.tsx"), "export function CheckoutPage() {}\n");
    writeFileSync(join(base, "web", "README.md"), "# web\n");
    web0 = commit(join(base, "web"), "initial");
    mkdirSync(join(base, "orders", "src"));
    writeFileSync(join(base, "orders", "src", "Handler.kt"), "fun placeOrder() {}\n");
    writeFileSync(join(base, "orders", "src", "OpenOrders.kt"), "class OpenOrders\n");
    orders0 = commit(join(base, "orders"), "initial");

    expect(em(["scaffold", "Shop"], modelRepo).status).toBe(0);
    dir = join(modelRepo, "shop");
    writeFileSync(join(dir, "shop.em"), MODEL);
    writeFileSync(join(modelRepo, "system.yaml"), SYSTEM);
    writeFileSync(join(dir, "code-map.yaml"), MAP);
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "place-order.md"), DOC("state-change"));
    writeFileSync(join(dir, "slices", "open-orders.md"), DOC("state-view"));
    mkdirSync(join(dir, "conformance", "bindings"), { recursive: true });
    writeFileSync(join(dir, "conformance", "bindings", "place-order.yaml"), BIND_PLACE);
    writeFileSync(join(dir, "conformance", "bindings", "open-orders.yaml"), BIND_OPEN);
    for (const [key, n] of [["place-order", 1], ["open-orders", 2]] as const) {
      expect(em(["slice", "mark-implemented", "shop.em", key, `https://github.com/acme/orders/pull/${n}`], dir).status).toBe(0);
    }
    commit(modelRepo, "model");
    expect(em(["model", "version", "bump", "shop.em", "--by", "Alex Rivera"], dir).status).toBe(0);
    recorded = `orders=${orders0},web=${web0}`;
    const set = em(["state", "set-conformance", recorded, "--report", "conformance/r.md"], dir);
    expect(set.stderr + set.stdout).toContain("");
    expect(set.status).toBe(0);

    // After the run: the frontend half of place-order changes, plus an unrelated file there;
    // the orders repo gets two commits, one to open-orders' view.
    writeFileSync(join(base, "web", "src", "Checkout.tsx"), "export function CheckoutPage() { /* changed */ }\n");
    writeFileSync(join(base, "web", "README.md"), "# web, updated\n");
    commit(join(base, "web"), "checkout page");
    writeFileSync(join(base, "orders", "src", "OpenOrders.kt"), "class OpenOrders // changed\n");
    commit(join(base, "orders"), "open orders");
    writeFileSync(join(base, "orders", "NOTES.md"), "notes\n");
    commit(join(base, "orders"), "notes");
  });
  afterAll(() => rmTemp(base));

  it("conform-scope: each repo diffed at its own revision, paths written <repo>:<path>, slices placed within their repo", () => {
    const r = em(["conform-scope", "shop.em"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.lastConformance.revision).toBe(recorded);
    expect(doc.changedPaths).toEqual(["web:README.md", "web:src/Checkout.tsx", "orders:NOTES.md", "orders:src/OpenOrders.kt"]);
    expect(doc.candidateSlices).toEqual([
      { key: "place-order", matchedBy: "bindings", paths: ["web:src/Checkout.tsx"], file: null },
      // No `repo:` on this binding: the slice's one repository, from the code map.
      { key: "open-orders", matchedBy: "bindings", paths: ["orders:src/OpenOrders.kt"], file: null },
    ]);
    expect(doc.unmappedPaths).toEqual(["web:README.md", "orders:NOTES.md"]);
    expect(doc.repos).toEqual([
      { repo: "web", revision: web0, changedPaths: ["README.md", "src/Checkout.tsx"], unmappedPaths: ["README.md"], error: null },
      { repo: "orders", revision: orders0, changedPaths: ["NOTES.md", "src/OpenOrders.kt"], unmappedPaths: ["NOTES.md"], error: null },
    ]);
  });

  it("conform-scope --full: every shipped slice, and each repo's recorded revision", () => {
    const doc = JSON.parse(em(["conform-scope", "shop.em", "--full"], dir).stdout);
    expect(doc.candidateSlices.map((c: any) => [c.key, c.matchedBy])).toEqual([["place-order", "full"], ["open-orders", "full"]]);
    expect(doc.repos.map((x: any) => [x.repo, x.revision, x.error])).toEqual([["web", web0, null], ["orders", orders0, null]]);
  });

  it("freshness and status: totals over the repos, with the per-repo breakdown", () => {
    const fresh = JSON.parse(em(["freshness", "shop.em", "--json"], dir).stdout);
    expect(fresh.commitsBehindHead).toBe(3);
    expect(fresh.slicePRsBehindHead).toBe(2);
    expect(fresh.error).toBeNull();
    expect(fresh.repos).toEqual([
      { repo: "web", revision: web0, commitsBehindHead: 1, error: null },
      { repo: "orders", revision: orders0, commitsBehindHead: 2, error: null },
    ]);
    expect(em(["freshness", "shop.em"], dir).stdout.trim()).toBe(`last conformed ${recorded} — 3 commits and 2 slice-PRs behind HEAD`);
    const status = JSON.parse(em(["status", "shop.em", "--json"], dir).stdout);
    expect(status.conformance[0].repos).toEqual(fresh.repos);
    expect(status.conformance[0].commitsBehindHead).toBe(3);
  });

  it("a repo with no checkout here is reported and the others are still compared; --repo <id>=<path> supplies it", () => {
    const moved = join(base, "web-elsewhere");
    spawnSync("mv", [join(base, "web"), moved]);
    try {
      const doc = JSON.parse(em(["conform-scope", "shop.em"], dir).stdout);
      expect(doc.repos[0]).toMatchObject({ repo: "web", changedPaths: [] });
      expect(doc.repos[0].error).toContain('repo "web" has no checkout here');
      expect(doc.candidateSlices.map((c: any) => c.key)).toEqual(["open-orders"]);
      const text = em(["freshness", "shop.em"], dir).stdout.trim();
      expect(text).toBe(`last conformed ${recorded} — 2 commits and 1 slice-PR behind HEAD (1 of 2 repos compared — not web)`);
      const ok = JSON.parse(em(["conform-scope", "shop.em", "--repo", `web=${moved}`], dir).stdout);
      expect(ok.repos[0].error).toBeNull();
      expect(ok.candidateSlices).toHaveLength(2);
    } finally {
      spawnSync("mv", [moved, join(base, "web")]);
    }
  });

  it("a repo the recorded revision does not cover says so", () => {
    expect(em(["state", "set-conformance", `orders=${orders0}`, "--report", "conformance/r.md", "--partial"], dir).status).toBe(0);
    const doc = JSON.parse(em(["conform-scope", "shop.em"], dir).stdout);
    expect(doc.repos[0]).toMatchObject({ repo: "web", revision: null });
    expect(doc.repos[0].error).toContain('no revision is recorded for repo "web"');
    expect(doc.repos[1].error).toBeNull();
    expect(em(["state", "set-conformance", recorded, "--report", "conformance/r.md", "--partial"], dir).status).toBe(0);
  });

  it("a bare --repo is refused when the code is in two repositories", () => {
    const r = em(["conform-scope", "shop.em", "--repo", join(base, "orders")], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("this model's code is in 2 repositories (web, orders), so a bare path is ambiguous");
  });

  it("layout 2: one code repo, a plain recorded revision, no flags — the code repo is found and compared", () => {
    writeFileSync(join(dir, "code-map.yaml"), `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders}\n`);
    writeFileSync(join(dir, "conformance", "bindings", "place-order.yaml"), BIND_PLACE.replace(/  - \{ref: ui.checkout.*\n/, "").replace('"1.1"', '"1.0"').replace("repo: orders, ", ""));
    expect(em(["state", "set-conformance", orders0, "--report", "conformance/r.md", "--partial"], dir).status).toBe(0);
    const doc = JSON.parse(em(["conform-scope", "shop.em"], dir).stdout);
    expect(doc.repos).toEqual([{ repo: "orders", revision: orders0, changedPaths: ["NOTES.md", "src/OpenOrders.kt"], unmappedPaths: ["NOTES.md"], error: null }]);
    expect(doc.candidateSlices.map((c: any) => c.key)).toEqual(["open-orders"]);
    // The pre-1.24 way still works: a bare --repo names the one code repo.
    const bare = JSON.parse(em(["conform-scope", "shop.em", "--repo", join(base, "orders")], dir).stdout);
    expect(bare.candidateSlices).toEqual(doc.candidateSlices);
    expect(em(["freshness", "shop.em"], dir).stdout.trim()).toContain(`last conformed ${orders0} — 2 commits and 1 slice-PR behind HEAD`);
  });
});
