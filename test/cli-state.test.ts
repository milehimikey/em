// SPDX-License-Identifier: MIT
// CLI-level coverage for `em state` (commander wiring, exit codes, stdout/stderr): the
// underlying pure logic (parsing, formatting, byte-identical rewrites) is covered without
// spawning a process in test/stateFile.test.ts — same split as em changelog
// (test/changelog.test.ts vs the "em changelog (CLI, real git repo)" block in test/cli.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { localIsoDate } from "../src/util/localDate.js";
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
      lastUpdated: localIsoDate(),
      lastConformance: null,
      modelVersion: null,
      certified: null,
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

  it("set-conformance refuses to write anything (MIL-218) when no model-versions/ manifest exists yet", () => {
    const before = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    const r = em(
      ["state", "set-conformance", "abc123f", modelDir(), "--report", "conformance/2026-08-21-report.md"],
      cwd,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bump a model version first");
    // Refuses BEFORE writing anything — Last conformance: must stay untouched.
    const after = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(after).toBe(before);
  });

  it("set-conformance writes the exact format, certifies the bumped model version, and round-trips through read", () => {
    const bump = em(["model", "version", "bump", join(modelDir(), "order-fulfillment.em"), "--by", "Alex"], cwd);
    expect(bump.status).toBe(0);

    const w = em(
      ["state", "set-conformance", "abc123f", modelDir(), "--report", "conformance/2026-08-21-report.md"],
      cwd,
    );
    expect(w.status).toBe(0);
    expect(w.stdout).toContain("certified:");
    const text = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(text).toContain(
      "- **Last conformance:** " +
        localIsoDate() +
        " @ abc123f — report: conformance/2026-08-21-report.md",
    );
    expect(text).toContain("- **Model version:** 1");
    expect(text).toContain("- **Certified:** v1 @ abc123f (" + localIsoDate() + ")");
    const r = em(["state", "read", modelDir()], cwd);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.lastConformance).toEqual({
      date: localIsoDate(),
      revision: "abc123f",
      report: "conformance/2026-08-21-report.md",
      partial: false,
    });
    expect(parsed.modelVersion).toBe(1);
    expect(parsed.certified).toEqual({ version: 1, revision: "abc123f", date: localIsoDate() });
  });

  it("set-conformance refuses while a slice:null finding is unruled, and --partial escapes with a notice", () => {
    mkdirSync(join(modelDir(), "conformance"), { recursive: true });
    writeFileSync(
      join(modelDir(), "conformance", "2026-08-25-findings.json"),
      JSON.stringify(
        {
          findingsSchemaVersion: "1.0",
          model: "order-fulfillment.em",
          report: "conformance/2026-08-25-report.md",
          revision: "def456a",
          findings: [
            {
              id: 1,
              surface: "internal",
              class: "Internal inconsistency",
              slice: null,
              evidence: "e1",
              locus: null,
              resolvedBy: null,
              resolvedOn: null,
            },
          ],
        },
        null,
        2,
      ),
    );

    const refused = em(
      ["state", "set-conformance", "def456a", modelDir(), "--report", "conformance/2026-08-25-report.md"],
      cwd,
    );
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("1 unruled conformance finding(s) among implemented slices");
    expect(refused.stderr).toContain("--partial");

    const partial = em(
      ["state", "set-conformance", "def456a", modelDir(), "--report", "conformance/2026-08-25-report.md", "--partial"],
      cwd,
    );
    expect(partial.status).toBe(0);
    expect(partial.stderr).toContain("notice: conformance marker recorded as PARTIAL — 1 finding(s) unruled");
    const text = readFileSync(join(modelDir(), ".event-modeling.md"), "utf8");
    expect(text).toContain(
      "- **Last conformance:** " + localIsoDate() + " @ def456a — report: conformance/2026-08-25-report.md (partial)",
    );
    const r = em(["state", "read", modelDir()], cwd);
    expect(JSON.parse(r.stdout).lastConformance.partial).toBe(true);
  });

  it(
    "set-review validates the date and round-trips through read",
    () => {
      // 3 real CLI spawns in one test (MIL-205) — same headroom concern as the multi-spawn
      // tests below: each spawn is a fresh `tsx` process, so this can sit close to vitest's
      // 5000ms default on a slow runner.
      const bad = em(["state", "set-review", "not-a-date", modelDir()], cwd);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("YYYY-MM-DD");

      const w = em(["state", "set-review", "2026-08-21", modelDir()], cwd);
      expect(w.status).toBe(0);
      const r = em(["state", "read", modelDir()], cwd);
      expect(JSON.parse(r.stdout).lastReview).toBe("2026-08-21");
    },
    20000,
  );

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

  it(
    "--json prints a versioned document with the same counts",
    () => {
      // 3 real CLI spawns (MIL-205) — same headroom concern as the "aggregates..." test above.
      em(["scaffold", "Model One"], cwd);
      em(["state", "log-usage", join(cwd, "model-one", "model-one.em"), "--phases", "discover"], cwd);

      const r = em(["usage-report", cwd, "--json"], cwd);
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.usageReportSchemaVersion).toBe("1.0");
      expect(doc.sessions).toBe(1);
      expect(doc.phaseCounts).toEqual([{ key: "discover", count: 1 }]);
      expect(doc.unparseableLines).toEqual([]);
    },
    20000,
  );

  it(
    "defaults [root] to the current directory",
    () => {
      // 3 real CLI spawns (MIL-205) — same headroom concern as the "aggregates..." test above.
      em(["scaffold", "Model One"], cwd);
      em(["state", "log-usage", join(cwd, "model-one", "model-one.em"), "--phases", "discover"], cwd);
      const r = em(["usage-report"], cwd);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("1 state file(s)");
    },
    20000,
  );

  it("reports zero files/sessions cleanly when nothing is found", () => {
    const r = em(["usage-report", cwd], cwd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 state file(s)");
    expect(r.stdout).toContain("(none logged)");
  });
});
