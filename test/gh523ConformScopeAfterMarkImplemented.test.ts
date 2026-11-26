// SPDX-License-Identifier: MIT
// GH #523: the documented flow end to end, with the real commands and a real git repo.
// `em slice mark-implemented` records a PR URL in `implementedIn:`; `em conform-scope` used to map
// a changed path to a slice only through an `implementedIn:` that was itself a path, so a project
// that followed the flow got no candidate slices and "0 slice-PRs behind HEAD" forever. The
// slice's bindings manifest (docs/bindings.md) is the path record the flow does write, so it is
// what places a changed file now.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitInitQuiet } from "./helpers/gitInitQuiet.js";
import { rmTemp } from "./helpers/rmTemp.js";

// beforeAll spawns the CLI six times; a CI runner needs more than the 10s hook default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}
const git = (args: string[], cwd: string) =>
  spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

const MODEL =
  `slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order note "slices/place-order.md"\n  event Order Placed\n}\n` +
  `slice "Open Orders" {\n  view Open Orders from "Order Placed"\n  ui Order List @Customer\n}\n` +
  `slice "Ship Order" {\n  ui Shipping @Customer\n  command Ship Order note "slices/ship-order.md"\n  event Order Shipped\n}\n` +
  `slice "Shipped Orders" {\n  view Shipped Orders from "Order Shipped"\n  ui Shipment List @Customer\n}\n`;

const READY_DOC =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n## Intent\n";

const BINDINGS = (slice: string, command: string, event: string, dir: string, handler: string, eventId: string) =>
  `bindingsSchemaVersion: "1.0"\nslice: ${slice}\nelements:\n` +
  `  - ref: ${command}\n    file: src/${dir}/Handler.kt\n    identifier: ${handler}\n` +
  `  - ref: ${event}\n    file: src/${dir}/Events.kt\n    identifier: ${eventId}\n`;

describe("GH #523: conform-scope after `em slice mark-implemented <pr-url>`", () => {
  let repo: string;
  let modelDir: string;
  let baseRev: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "em-gh523-"));
    gitInitQuiet(repo, "-b", "main");
    expect(em(["scaffold", "Checkout"], repo).status).toBe(0);
    modelDir = join(repo, "checkout");
    writeFileSync(join(modelDir, "checkout.em"), MODEL);
    mkdirSync(join(modelDir, "slices"), { recursive: true });
    writeFileSync(join(modelDir, "slices", "place-order.md"), READY_DOC);
    writeFileSync(join(modelDir, "slices", "ship-order.md"), READY_DOC);

    // The implementation, and the bindings manifests the implement step writes with it.
    for (const [dir, body] of [["orders", "fun placeOrder() {}\n"], ["shipping", "fun shipOrder() {}\n"]] as const) {
      mkdirSync(join(repo, "src", dir), { recursive: true });
      writeFileSync(join(repo, "src", dir, "Handler.kt"), body);
    }
    writeFileSync(join(repo, "src", "orders", "Events.kt"), "class OrderPlaced\n");
    writeFileSync(join(repo, "src", "shipping", "Events.kt"), "class OrderShipped\n");
    writeFileSync(join(repo, "README.md"), "# demo\n");
    mkdirSync(join(modelDir, "conformance", "bindings"), { recursive: true });
    writeFileSync(
      join(modelDir, "conformance", "bindings", "place-order.yaml"),
      BINDINGS("place-order", "command.place-order", "event.order-placed", "orders", "placeOrder", "OrderPlaced"),
    );
    writeFileSync(
      join(modelDir, "conformance", "bindings", "ship-order.yaml"),
      BINDINGS("ship-order", "command.ship-order", "event.order-shipped", "shipping", "shipOrder", "OrderShipped"),
    );

    // The merge-time flip, exactly as the implement and engagement skills run it: a PR URL.
    for (const [key, n] of [["place-order", 41], ["ship-order", 42]] as const) {
      const r = em(["slice", "mark-implemented", "checkout.em", key, `https://github.com/acme/shop/pull/${n}`], modelDir);
      expect(r.status).toBe(0);
    }
    expect(readFileSync(join(modelDir, "slices", "place-order.md"), "utf8")).toContain(
      "implementedIn: https://github.com/acme/shop/pull/41",
    );

    git(["add", "."], repo);
    git(["commit", "-qm", "model, slices, code"], repo);
    baseRev = git(["rev-parse", "HEAD"], repo).stdout.trim();

    expect(em(["model", "version", "bump", "checkout.em", "--by", "Alex Rivera"], modelDir).status).toBe(0);
    const set = em(["state", "set-conformance", baseRev, "--report", "conformance/2026-11-25-report.md"], modelDir);
    expect(set.status).toBe(0);

    // After the conformance run: one slice's code changes, and so does an unrelated file.
    writeFileSync(join(repo, "src", "orders", "Handler.kt"), "fun placeOrder() { /* changed */ }\n");
    writeFileSync(join(repo, "README.md"), "# demo, updated\n");
    git(["add", "src", "README.md"], repo);
    git(["commit", "-qm", "change the place-order handler"], repo);
  });
  afterAll(() => rmTemp(repo));

  it("places the changed file in the slice whose bindings manifest names it", () => {
    const r = em(["conform-scope", "checkout.em", "--repo", repo], modelDir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.changedPaths.sort()).toEqual(["README.md", "src/orders/Handler.kt"]);
    expect(doc.candidateSlices).toEqual([
      { key: "place-order", matchedBy: "bindings", paths: ["src/orders/Handler.kt"], file: null },
    ]);
    expect(doc.unmappedPaths).toEqual(["README.md"]);
  });

  it("em freshness and em status count that slice as behind HEAD", () => {
    const fresh = em(["freshness", "checkout.em", "--repo", repo, "--json"], modelDir);
    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout).slicePRsBehindHead).toBe(1);
    const status = em(["status", "checkout.em", "--repo", repo, "--json"], modelDir);
    expect(JSON.parse(status.stdout).conformance[0].slicePRsBehindHead).toBe(1);
  });
});
