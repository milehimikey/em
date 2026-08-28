// SPDX-License-Identifier: MIT
// CLI-level coverage for `em state` (commander wiring, exit codes, stdout/stderr): the
// underlying pure logic (parsing, formatting, byte-identical rewrites) is covered without
// spawning a process in test/stateFile.test.ts — same split as em changelog
// (test/changelog.test.ts vs the "em changelog (CLI, real git repo)" block in test/cli.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("log-usage appends a canonical line, deduping/sorting --phases, computed from a clean model", () => {
    const w = em(["state", "log-usage", join(modelDir(), "order-fulfillment.em"), "--phases", "slice,model,slice"], cwd);
    expect(w.status).toBe(0);
    expect(w.stdout).toContain("phases: model, slice — validate: none");
    const text = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(text).toMatch(/- \d{4}-\d{2}-\d{2}: phases: model, slice — validate: none/);
  });

  it("log-usage picks up real diagnostic categories, deduped and sorted", () => {
    const emPath = join(modelDir(), "order-fulfillment.em");
    const original = readFileSync(emPath, "utf8");
    // Append an event nobody reads — two real diagnostic categories.
    writeFileSync(emPath, original + '\nslice "Orphan" {\n  event Orphan Happened\n}\n');
    const w = em(["state", "log-usage", emPath, "--phases", "model"], cwd);
    expect(w.status).toBe(0);
    expect(w.stdout).toContain("event has no producing command");
    expect(w.stdout).toContain("event not read by any read model");
    const text = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(text).toContain("validate: event has no producing command, event not read by any read model");
  });

  it("log-usage rejects an invalid phase, without writing", () => {
    const before = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    const r = em(["state", "log-usage", join(modelDir(), "order-fulfillment.em"), "--phases", "bogus"], cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid phase(s) "bogus"');
    expect(readFileSync(join(modelDir(), ".event-modeling.md"), "utf8")).toBe(before);
  });

  it("log-usage requires --phases", () => {
    const r = em(["state", "log-usage", join(modelDir(), "order-fulfillment.em")], cwd);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--phases");
  });

  it("log-usage fails clearly, non-zero, when the state file is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "em-cli-state-empty-"));
    writeFileSync(join(empty, "m.em"), 'slice "S" {\n  command Do Thing\n  event Thing Done\n}\n');
    const r = em(["state", "log-usage", "m.em", "--phases", "model"], empty);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no state file at");
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("em usage-report (CLI, MIL-161)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-cli-usage-report-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  // 5 real CLI subprocess spawns (2x scaffold, 2x log-usage, 1x usage-report) in one test —
  // each is a fresh `tsx` process, not a function call, so this is inherently slower than the
  // rest of the file. ~1.9s locally leaves too little headroom against vitest's 5000ms default
  // once a CI runner's spawn overhead runs 3-4x slower than local (observed: this test alone
  // timed out in CI while passing locally) — an explicit timeout, not a smaller one hidden in
  // vitest.config.ts, so the "why" travels with the test that needs it.
  it(
    "aggregates across every .event-modeling.md found under the root, text report",
    () => {
      em(["scaffold", "Model One"], cwd);
      em(["scaffold", "Model Two"], cwd);
      em(["state", "log-usage", join(cwd, "model-one", "model-one.em"), "--phases", "discover"], cwd);
      em(["state", "log-usage", join(cwd, "model-two", "model-two.em"), "--phases", "discover,model"], cwd);

      const r = em(["usage-report", cwd], cwd);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("2 state file(s)");
      expect(r.stdout).toContain("2 logged session(s)");
      expect(r.stdout).toContain("2\tdiscover");
      expect(r.stdout).toContain("1\tmodel");
    },
    20000,
  );

  it("--json prints a versioned document with the same counts", () => {
    em(["scaffold", "Model One"], cwd);
    em(["state", "log-usage", join(cwd, "model-one", "model-one.em"), "--phases", "discover"], cwd);

    const r = em(["usage-report", cwd, "--json"], cwd);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.usageReportSchemaVersion).toBe("1.0");
    expect(doc.sessions).toBe(1);
    expect(doc.phaseCounts).toEqual([{ key: "discover", count: 1 }]);
    expect(doc.unparseableLines).toEqual([]);
  });

  it("defaults [root] to the current directory", () => {
    em(["scaffold", "Model One"], cwd);
    em(["state", "log-usage", join(cwd, "model-one", "model-one.em"), "--phases", "discover"], cwd);
    const r = em(["usage-report"], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 state file(s)");
  });

  it("reports zero files/sessions cleanly when nothing is found", () => {
    const r = em(["usage-report", cwd], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 state file(s)");
    expect(r.stdout).toContain("(none logged)");
  });
});
