// SPDX-License-Identifier: MIT
// CLI-level coverage for `em export` / `em validate --list-issues` /
// `--fail-on-issues`: spawns the real CLI (via tsx) so the commander wiring,
// exit codes, and stdout/stderr split are exercised, not just the underlying
// functions (which test/export.test.ts and test/validate.test.ts cover).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const CLEAN = `slice "Place" {
  command Place Order
  event Order Placed
}
`;

// One warning (command with no event), no errors.
const WARNING_ONLY = `slice "Place" {
  command Place Order
}
`;

const WITH_ISSUE = `slice "Place" {
  command Place Order issue "who validates the discount code?"
  event Order Placed
}
`;

// Error: view sourced from an event that doesn't exist.
const WITH_ERROR = `slice "Read" {
  view Open Orders from "No Such Event"
}
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-cli-"));
  writeFileSync(join(dir, "clean.em"), CLEAN);
  writeFileSync(join(dir, "warn.em"), WARNING_ONLY);
  writeFileSync(join(dir, "issue.em"), WITH_ISSUE);
  writeFileSync(join(dir, "error.em"), WITH_ERROR);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("em export (CLI)", () => {
  it("-o writes the file and confirms on stdout", () => {
    const r = em(["export", "clean.em", "-o", "out.json"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote out.json");
    const doc = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(doc.schemaVersion).toBe("1.0");
  });

  it("stdout stays clean parseable JSON when warnings are present (warnings go to stderr)", () => {
    const r = em(["export", "warn.em"], dir);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout); // throws if any warning text leaked into stdout
    expect(doc.schemaVersion).toBe("1.0");
    expect(r.stderr).toContain("produces no event");
  });

  it("refuses on errors with a non-zero exit", () => {
    const r = em(["export", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not exporting");
  });
});

describe("em validate --list-issues / --fail-on-issues (CLI)", () => {
  it("--list-issues prints slice, element, line, and text per open issue", () => {
    const r = em(["validate", "--list-issues", "issue.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /issue :2 slice "Place" command "Place Order": who validates the discount code\?/,
    );
  });

  it("--list-issues reports when there are none", () => {
    const r = em(["validate", "--list-issues", "clean.em"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no open issues");
  });

  it("--fail-on-issues exits 1 while issues remain, 0 once clear", () => {
    expect(em(["validate", "--fail-on-issues", "issue.em"], dir).status).toBe(1);
    expect(em(["validate", "--fail-on-issues", "clean.em"], dir).status).toBe(0);
  });

  it("--list-issues on a model with errors still prints the errors before exiting 1", () => {
    const r = em(["validate", "--list-issues", "error.em"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown event "No Such Event"');
  });
});
