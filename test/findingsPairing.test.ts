// SPDX-License-Identifier: MIT
// GH #391: the three callers of `lookupFindingsBesideReport` pair a report with its findings
// record the same way (one helper, `resolveFindingsForReport`): readers (`em state
// set-conformance`, `em status`) keep the exact-stem twin and otherwise read every same-revision
// findings file; the writer (`em conform-supersede`) keeps the exact stem and REFUSES, naming
// the same-revision files, when the twin is absent but some exist.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConformanceEntry } from "../src/cli/status.js";
import { GitResult, GitRunner } from "../src/cli/diff-inputs.js";
import { runConformSupersede } from "../src/cli/conformSupersede.js";
import { resolveFindingsForReport } from "../src/cli/sliceConform.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const REV = "abc1234";
const REPORT = "conformance/2026-01-01-report.md";
const REPORT_BODY = "# Conformance Report — Test — 2026-01-01\n\nbody\n";

interface F {
  id: number;
  slice?: string | null;
  locus?: "code" | null;
}
function findingsJson(revision: string, findings: F[]): string {
  return JSON.stringify(
    {
      findingsSchemaVersion: "1.0",
      model: "m.em",
      report: REPORT,
      revision,
      findings: findings.map((f) => ({
        id: f.id,
        surface: "structural",
        class: "Real drift",
        slice: f.slice ?? null,
        evidence: `e${f.id}`,
        locus: f.locus ?? null,
        resolvedBy: f.locus ? "Alex" : null,
        resolvedOn: f.locus ? "2026-01-02" : null,
      })),
    },
    null,
    2,
  );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "em-findings-pairing-"));
  mkdirSync(join(dir, "conformance"), { recursive: true });
  writeFileSync(join(dir, REPORT), REPORT_BODY);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, revision: string, findings: F[]) =>
  writeFileSync(join(dir, "conformance", name), findingsJson(revision, findings));

describe("resolveFindingsForReport (GH #391)", () => {
  it("returns the exact-stem twin when present, even if other same-revision files exist", () => {
    put("2026-01-01-findings.json", REV, [{ id: 1 }]);
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 7 }]);
    const r = resolveFindingsForReport(dir, REPORT, REV);
    expect(r.kind).toBe("twin");
    if (r.kind === "twin") expect(r.path).toBe("conformance/2026-01-01-findings.json");
  });
  it("returns every same-revision file when the twin is absent, and none for another revision", () => {
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    put("2026-01-01-abc-0002-findings.json", REV, [{ id: 1 }]);
    put("2026-01-01-other-findings.json", "ffff999", [{ id: 1 }]);
    const r = resolveFindingsForReport(dir, REPORT, REV);
    expect(r.kind).toBe("revision");
    if (r.kind === "revision") expect(r.files.map((f) => f.path).sort()).toEqual(["conformance/2026-01-01-abc-0001-findings.json", "conformance/2026-01-01-abc-0002-findings.json"]);
    expect(resolveFindingsForReport(dir, REPORT, "0000000").kind).toBe("none");
  });
  it("an invalid twin still refuses", () => {
    writeFileSync(join(dir, "conformance", "2026-01-01-findings.json"), "{ nope");
    expect(resolveFindingsForReport(dir, REPORT, REV).kind).toBe("invalid");
  });
});

describe("em state set-conformance (GH #391)", () => {
  let cwd: string;
  let mdir: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "em-findings-pairing-state-"));
    expect(em(["scaffold", "Order Fulfillment"], cwd).status).toBe(0);
    mdir = join(cwd, "order-fulfillment");
    mkdirSync(join(mdir, "conformance"), { recursive: true });
    writeFileSync(join(mdir, REPORT), REPORT_BODY);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const putM = (name: string, revision: string, findings: F[]) =>
    writeFileSync(join(mdir, "conformance", name), findingsJson(revision, findings));
  const setConf = (extra: string[] = []) => em(["state", "set-conformance", REV, mdir, "--report", REPORT, ...extra], cwd);

  it("the issue repro: refuses, naming the same-revision file and the unruled id, when only a per-run file exists", () => {
    putM("2026-01-01-abc-0001-findings.json", REV, [{ id: 3 }]);
    const r = setConf();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("1 unruled conformance finding(s) among implemented slices");
    expect(r.stderr).toContain("conformance/2026-01-01-abc-0001-findings.json (id 3)");
    expect(r.stderr).not.toContain("no findings JSON found");
  });

  it("merges two same-revision files, naming every file read with its ids", () => {
    putM("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    putM("2026-01-01-abc-0002-findings.json", REV, [{ id: 1 }, { id: 2, locus: "code" }]);
    putM("2026-01-01-abc-0003-findings.json", REV, [{ id: 1, locus: "code" }]);
    putM("2026-01-01-zzz-findings.json", "ffff999", [{ id: 9 }]);
    const r = setConf();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("2 unruled conformance finding(s)");
    expect(r.stderr).toContain("conformance/2026-01-01-abc-0001-findings.json (id 1)");
    expect(r.stderr).toContain("conformance/2026-01-01-abc-0002-findings.json (id 1)");
    expect(r.stderr).toContain("conformance/2026-01-01-abc-0003-findings.json (no unruled)");
    expect(r.stderr).not.toContain("zzz");
  });

  it("--partial still escapes with a notice", () => {
    putM("2026-01-01-abc-0001-findings.json", REV, [{ id: 3 }]);
    const r = setConf(["--partial"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("notice: conformance marker recorded as PARTIAL — 1 finding(s) unruled");
  });

  it("the exact-stem twin still wins when both exist (other same-revision files are not read)", () => {
    putM("2026-01-01-findings.json", REV, [{ id: 1, locus: "code" }]);
    putM("2026-01-01-abc-0001-findings.json", REV, [{ id: 5 }]);
    const r = setConf();
    expect(r.stderr).not.toContain("unruled conformance finding");
    expect(r.stderr).not.toContain("abc-0001");
  });

  it("migration path unchanged: warns when neither a twin nor any same-revision file exists", () => {
    putM("2026-01-01-abc-0001-findings.json", "ffff999", [{ id: 5 }]);
    const r = setConf();
    expect(r.stderr).toContain("warn: no findings JSON found beside");
    expect(r.stderr).not.toContain("unruled conformance finding");
  });

  it("an invalid twin still refuses", () => {
    writeFileSync(join(mdir, "conformance", "2026-01-01-findings.json"), "{ nope");
    const r = setConf();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("2026-01-01-findings.json");
  });
});

describe("em status unruledFindings (GH #391)", () => {
  const fakeGit = (responses: GitResult[]): GitRunner => {
    let i = 0;
    return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
  };
  const okR = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
  const entry = () => {
    writeFileSync(
      join(dir, ".event-modeling.md"),
      "- **Model file:** `model.em`\n- **Current phase:** conform\n- **Current step:** 1\n" +
        `- **Last updated:** 2026-01-01\n- **Last conformance:** 2026-01-01 @ ${REV} — report: ${REPORT}\n` +
        "- **Last stakeholder review:** never\n",
    );
    const runGit = fakeGit([okR(`${dir}\n`), okR("0\n"), okR(`${dir}\n`), okR("")]);
    return resolveConformanceEntry(join(dir, "model.em"), undefined, [], runGit);
  };

  it("counts the unruled findings of a per-run file at the marker's revision (was null)", () => {
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }, { id: 2, locus: "code" }]);
    expect(entry().unruledFindings).toBe(1);
  });
  it("sums across several same-revision files", () => {
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    put("2026-01-01-abc-0002-findings.json", REV, [{ id: 1 }]);
    expect(entry().unruledFindings).toBe(2);
  });
  it("the exact-stem twin wins when both exist", () => {
    put("2026-01-01-findings.json", REV, [{ id: 1, locus: "code" }]);
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }, { id: 2 }]);
    expect(entry().unruledFindings).toBe(0);
  });
  it("stays null when no file sits at that revision (migration path)", () => {
    put("2026-01-01-abc-0001-findings.json", "ffff999", [{ id: 1 }]);
    expect(entry().unruledFindings).toBeNull();
  });
});

describe("em conform-supersede (GH #391)", () => {
  const ruling = { locus: "code" as const, by: "Alex Rivera" };

  it("refuses, naming the report and every same-revision file, when the twin is absent and some exist", () => {
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    put("2026-01-01-abc-0002-findings.json", REV, [{ id: 1 }]);
    const r = runConformSupersede(dir, REPORT, REV, "1", "2026-01-02", ruling);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain(`findings file beside ${REPORT} not found`);
    expect(r.message).toContain("conformance/2026-01-01-abc-0001-findings.json");
    expect(r.message).toContain("conformance/2026-01-01-abc-0002-findings.json");
    expect(r.message).toContain("name the report to match");
    expect(r.message).toContain("per-slice report");
    // nothing written: the report keeps no banner, the findings stay unruled
    expect(readFileSync(join(dir, REPORT), "utf8")).toBe(REPORT_BODY);
    expect(JSON.parse(readFileSync(join(dir, "conformance", "2026-01-01-abc-0001-findings.json"), "utf8")).findings[0].locus).toBeNull();
  });

  it("CLI: exits 1 and names the file", () => {
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    writeFileSync(join(dir, "m.em"), 'slice "A" {\n  ui Dashboard @Customer\n}\n');
    const r = em(["conform-supersede", "m.em", REPORT, "--as-of", REV, "--findings", "1", "--locus", "code", "--by", "Alex Rivera"], dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("conformance/2026-01-01-abc-0001-findings.json");
  });

  it("the exact-stem twin is still ruled when present, regardless of other same-revision files", () => {
    put("2026-01-01-findings.json", REV, [{ id: 1 }]);
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    const r = runConformSupersede(dir, REPORT, REV, "1", "2026-01-02", ruling);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "conformance", "2026-01-01-findings.json"), "utf8")).findings[0].locus).toBe("code");
    expect(JSON.parse(readFileSync(join(dir, "conformance", "2026-01-01-abc-0001-findings.json"), "utf8")).findings[0].locus).toBeNull();
  });

  it("migration path unchanged: banner-only warning when no file exists at the report's revision", () => {
    put("2026-01-01-abc-0001-findings.json", "ffff999", [{ id: 1 }]);
    const r = runConformSupersede(dir, REPORT, REV, "1", "2026-01-02", ruling);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.findingsRuling.kind).toBe("no-findings-file");
  });
});

describe("the report's own revision and malformed files (GH #391 amendment)", () => {
  const WITH_HEADER = `# Conformance Report — Test — 2026-01-01\n\n- **Target repo:** . @ \`${REV}\`\n`;
  const ruling = { locus: "code" as const, by: "Alex" };

  it("conform-supersede --as-of at a different revision still refuses: the report's header revision decides", () => {
    writeFileSync(join(dir, REPORT), WITH_HEADER);
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    const r = runConformSupersede(dir, REPORT, "def5678", "1", "2026-01-02", ruling);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("conformance/2026-01-01-abc-0001-findings.json");
    expect(readFileSync(join(dir, REPORT), "utf8")).toBe(WITH_HEADER);
  });

  it("a report with no Target repo line falls back to the caller's revision", () => {
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    expect(resolveFindingsForReport(dir, REPORT, REV).kind).toBe("revision");
    expect(resolveFindingsForReport(dir, REPORT, "def5678").kind).toBe("none");
  });

  it("set-conformance <other-rev> refuses with the unruled ids when the report header names the findings' revision", () => {
    const cwd = mkdtempSync(join(tmpdir(), "em-findings-pairing-hdr-"));
    try {
      expect(em(["scaffold", "Order Fulfillment"], cwd).status).toBe(0);
      const mdir = join(cwd, "order-fulfillment");
      mkdirSync(join(mdir, "conformance"), { recursive: true });
      writeFileSync(join(mdir, REPORT), WITH_HEADER);
      writeFileSync(join(mdir, "conformance", "2026-01-01-abc-0001-findings.json"), findingsJson(REV, [{ id: 3 }]));
      const r = em(["state", "set-conformance", "def5678", mdir, "--report", REPORT], cwd);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("conformance/2026-01-01-abc-0001-findings.json (id 3)");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a malformed same-date findings file with no twin is invalid, not the migration path", () => {
    writeFileSync(join(dir, "conformance", "2026-01-01-abc-0001-findings.json"), "{ nope");
    const r = resolveFindingsForReport(dir, REPORT, REV);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.message).toContain("conformance/2026-01-01-abc-0001-findings.json");
    const s = runConformSupersede(dir, REPORT, REV, "1", "2026-01-02", ruling);
    expect(s.ok).toBe(false);
  });
});

describe("tolerant Target repo header shapes (GH #391 fix-up 2)", () => {
  const shapes: [string, string][] = [
    ["plain template-less bullet with bold label", `- **Target repo:** ../app @ ${REV}`],
    ["no bullet, plain label, backticked revision", `Target repo: ../app @ \`${REV}\``],
    ["colon outside the bold label", `- **Target repo**: ../app @ ${REV}`],
    ["lower-case label", `- **target repo:** ../app @ ${REV}`],
    ["git URL containing @", `- **Target repo:** git@host:o/r.git @ \`${REV}\``],
    ["trailing text after the revision", `- **Target repo:** ../app @ ${REV} (clean checkout)`],
  ];
  for (const [name, header] of shapes) {
    it(`set-conformance <other-rev> refuses with the per-run file's id: ${name}`, () => {
      const cwd = mkdtempSync(join(tmpdir(), "em-findings-pairing-shape-"));
      try {
        expect(em(["scaffold", "Order Fulfillment"], cwd).status).toBe(0);
        const mdir = join(cwd, "order-fulfillment");
        mkdirSync(join(mdir, "conformance"), { recursive: true });
        writeFileSync(join(mdir, REPORT), `# Conformance Report — Test\n\n${header}\n`);
        writeFileSync(join(mdir, "conformance", "2026-01-01-abc-0001-findings.json"), findingsJson(REV, [{ id: 3 }]));
        const r = em(["state", "set-conformance", "def5678", mdir, "--report", REPORT], cwd);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("conformance/2026-01-01-abc-0001-findings.json (id 3)");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it("a Target repo line with no token after @ is treated as no header: falls back to the caller's revision", () => {
    writeFileSync(join(dir, REPORT), "# Conformance Report\n\n- **Target repo:** ../app @ \n");
    put("2026-01-01-abc-0001-findings.json", REV, [{ id: 1 }]);
    expect(resolveFindingsForReport(dir, REPORT, REV).kind).toBe("revision");
    expect(resolveFindingsForReport(dir, REPORT, "def5678").kind).toBe("none");
  });
});
