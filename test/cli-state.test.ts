// SPDX-License-Identifier: MIT
// CLI-level coverage for `em state` (commander wiring, exit codes, stdout/stderr): the
// underlying pure logic (parsing, formatting, byte-identical rewrites) is covered without
// spawning a process in test/stateFile.test.ts — same split as em changelog
// (test/changelog.test.ts vs the "em changelog (CLI, real git repo)" block in test/cli.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("em state (CLI)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-state-"));
    const r = em(["scaffold", "Order Fulfillment"], cwd);
    expect(r.status).toBe(0);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const modelDir = () => join(cwd, "order-fulfillment");

  it("read prints the scaffolded state file's mechanical fields as JSON", () => {
    const r = em(["state", "read", modelDir()], cwd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      modelPath: "order-fulfillment.em",
      phase: "discover",
      step: "1",
      lastUpdated: new Date().toISOString().slice(0, 10),
      lastConformance: null,
      lastReview: null,
    });
  });

  it("read defaults <dir> to the current directory", () => {
    const r = em(["state", "read"], modelDir());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).phase).toBe("discover");
  });

  it("read accepts a direct path to the state file", () => {
    const r = em(["state", "read", join(modelDir(), ".event-modeling.md")], cwd);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).phase).toBe("discover");
  });

  it("read fails clearly, non-zero, when the state file is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "em-cli-state-empty-"));
    const r = em(["state", "read", empty], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no state file at");
    rmSync(empty, { recursive: true, force: true });
  });

  it("set-phase rewrites Current phase: and round-trips through read", () => {
    const w = em(["state", "set-phase", "slice", modelDir()], cwd);
    expect(w.status).toBe(0);
    expect(w.stdout).toContain("wrote");
    const r = em(["state", "read", modelDir()], cwd);
    expect(JSON.parse(r.stdout).phase).toBe("slice");
  });

  it("set-phase --step also rewrites Current step:", () => {
    em(["state", "set-phase", "slice", modelDir(), "--step", "3"], cwd);
    const r = em(["state", "read", modelDir()], cwd);
    expect(JSON.parse(r.stdout).step).toBe("3");
  });

  it("set-phase rejects an invalid phase, listing the enum, without writing", () => {
    const before = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    const r = em(["state", "set-phase", "bogus", modelDir()], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("discover, extract, model, slice, implement, conform, review, validate");
    const after = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(after).toBe(before);
  });

  it("set-conformance writes the exact format and round-trips through read", () => {
    const w = em(
      ["state", "set-conformance", "abc123f", modelDir(), "--report", "conformance/2026-08-21-report.md"],
      cwd,
    );
    expect(w.status).toBe(0);
    const text = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(text).toContain(
      "- **Last conformance:** " +
        new Date().toISOString().slice(0, 10) +
        " @ abc123f — report: conformance/2026-08-21-report.md",
    );
    const r = em(["state", "read", modelDir()], cwd);
    expect(JSON.parse(r.stdout).lastConformance).toEqual({
      date: new Date().toISOString().slice(0, 10),
      revision: "abc123f",
      report: "conformance/2026-08-21-report.md",
    });
  });

  it("set-review validates the date and round-trips through read", () => {
    const bad = em(["state", "set-review", "not-a-date", modelDir()], cwd);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("YYYY-MM-DD");

    const w = em(["state", "set-review", "2026-08-21", modelDir()], cwd);
    expect(w.status).toBe(0);
    const r = em(["state", "read", modelDir()], cwd);
    expect(JSON.parse(r.stdout).lastReview).toBe("2026-08-21");
  });

  it("writers leave the rest of the file byte-identical", () => {
    const before = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    em(["state", "set-phase", "model", modelDir()], cwd);
    const after = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(beforeLines.length);
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i].startsWith("- **Current phase:**") || beforeLines[i].startsWith("- **Last updated:**")) continue;
      expect(afterLines[i]).toBe(beforeLines[i]);
    }
  });

  it("set-phase fails clearly, non-zero, when the state file is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "em-cli-state-empty-"));
    const r = em(["state", "set-phase", "model", empty], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no state file at");
    rmSync(empty, { recursive: true, force: true });
  });
});
