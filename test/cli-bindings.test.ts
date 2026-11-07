// SPDX-License-Identifier: MIT
// CLI-level coverage for `em conform bindings check` (GH #449): commander wiring, exit codes,
// stdout/stderr split, and `--json`/`--slice`/`--exit-code`. The underlying pure logic (shape
// validation, the check itself, determinism) is covered without spawning a process in
// test/bindings.test.ts — same split as `em conform-findings` (test/conformFindings.test.ts vs
// the CLI block in test/cli.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

// MIL-205 pattern: each spawn costs ~1 s on a GitHub runner; several tests here spawn more than
// once.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const MODEL = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}
`;

const VALID_BINDINGS = `bindingsSchemaVersion: "1.0"
slice: place-order
elements:
  - ref: command.place-order
    file: src/handler.ts
    identifier: placeOrder
invariants: []
`;

describe("em conform bindings check (CLI)", () => {
  let cwd: string;
  let repo: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-bindings-"));
    repo = mkdtempSync(join(tmpdir(), "em-cli-bindings-repo-"));
    writeFileSync(join(cwd, "model.em"), MODEL);
    mkdirSync(join(repo, "src"), { recursive: true });
  });
  afterEach(() => {
    rmTemp(cwd);
    rmTemp(repo);
  });

  function writeBindings(text: string) {
    mkdirSync(join(cwd, "conformance", "bindings"), { recursive: true });
    writeFileSync(join(cwd, "conformance", "bindings", "place-order.yaml"), text);
  }

  it("exits 0 and prints a passing report when every binding checks out", () => {
    writeBindings(VALID_BINDINGS);
    writeFileSync(join(repo, "src", "handler.ts"), "export function placeOrder() {}\n");
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[ok] command.place-order");
    expect(r.stdout).toContain("summary: 1 file(s) checked, 0 failed");
  });

  it("stays exit 0 by default even when a binding fails — advisory, never a gate", () => {
    writeBindings(VALID_BINDINGS);
    // No handler.ts written at all — the bound file is missing.
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[FAIL]");
    expect(r.stdout).toContain("file not found");
  });

  it("--exit-code turns a binding failure into a non-zero exit (the opt-in CI gate)", () => {
    writeBindings(VALID_BINDINGS);
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo, "--exit-code"], cwd);
    expect(r.status).toBe(1);
  });

  it("--exit-code stays 0 when everything passes", () => {
    writeBindings(VALID_BINDINGS);
    writeFileSync(join(repo, "src", "handler.ts"), "export function placeOrder() {}\n");
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo, "--exit-code"], cwd);
    expect(r.status).toBe(0);
  });

  it("--json prints the bindingsCheckSchemaVersion document and nothing else on stdout", () => {
    writeBindings(VALID_BINDINGS);
    writeFileSync(join(repo, "src", "handler.ts"), "export function placeOrder() {}\n");
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo, "--json"], cwd);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.bindingsCheckSchemaVersion).toBe("1.0");
    expect(doc.ok).toBe(true);
  });

  it("--slice scopes to one slice's bindings file", () => {
    writeBindings(VALID_BINDINGS);
    writeFileSync(join(repo, "src", "handler.ts"), "export function placeOrder() {}\n");
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo, "--slice", "place-order", "--json"], cwd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).slice).toBe("place-order");
  });

  it("exits 1 (unconditionally) for an unknown --slice key — a usage error, not a check failure", () => {
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo, "--slice", "no-such-slice"], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no slice with export key "no-such-slice"');
  });

  it("exits 1 (unconditionally) when the model itself has errors", () => {
    writeFileSync(join(cwd, "model.em"), 'slice "Broken" {\n  view Broken View from "No Such Event"\n}\n');
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo], cwd);
    expect(r.status).toBe(1);
  });

  it("reports 'no bindings files found' and exits 0 when conformance/bindings/ doesn't exist", () => {
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no bindings files found");
  });

  it("reports a distinct 'malformed' failure for invalid YAML", () => {
    writeBindings('bindingsSchemaVersion: "1.0"\nslice: place-order\nelements: "oops"\n');
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("malformed bindings file");
  });

  it("reports a distinct 'unknown element ref' failure", () => {
    writeBindings(
      'bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - ref: command.does-not-exist\n    file: src/handler.ts\n    identifier: x\ninvariants: []\n',
    );
    writeFileSync(join(repo, "src", "handler.ts"), "export function placeOrder() {}\n");
    const r = em(["conform", "bindings", "check", "model.em", "--repo", repo], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("unknown element ref (not in the model)");
  });
});
