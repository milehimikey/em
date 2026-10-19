// SPDX-License-Identifier: MIT
// GH #295: the PRD/spec discovery path. Covers the deterministic checker (src/cli/prdTriage.ts,
// `em discover triage-check`) on the Meridian Goods PRD-shaped narrative (examples/prd-triage) and a
// synthetic API spec with a Walkthroughs section (test/fixtures/prd-triage), the shipped rubric's
// parity with the skill bundle's data file, and grep gates on the skill text (the path is prose an
// agent follows, so the gate is that the required instructions exist).
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRD_RUBRIC,
  PRD_TRIAGE_SCHEMA_VERSION,
  buildCheckPrdTriageJson,
  checkPrdTriage,
  renderPrdTriageMarkdown,
  validatePrdTriage,
} from "../src/cli/prdTriage.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const MERIDIAN = join(ROOT, "examples", "prd-triage", "prd-triage.json");
const MERIDIAN_SRC = join(ROOT, "examples", "prd-triage", "meridian-prd.md");
const LIBRARY = join(ROOT, "test", "fixtures", "prd-triage", "library-triage.json");
const LIBRARY_SRC = join(ROOT, "test", "fixtures", "prd-triage", "library-api-spec.md");
const DISCOVER = join(ROOT, ".claude", "skills", "event-modeling-discover");

function em(args: string[], cwd = ROOT) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const flat = (p: string) => readFileSync(p, "utf8").replace(/[`*]/g, "").replace(/\s+/g, " ");
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** Mutate a deep copy of a triage doc and validate it against its source text. */
function mutated(path: string, srcPath: string, fn: (d: any) => void) {
  const d = load(path);
  fn(d);
  return validatePrdTriage(d, readFileSync(srcPath, "utf8"));
}
function errorsOf(r: ReturnType<typeof validatePrdTriage>): string[] {
  return r.ok ? [] : r.errors;
}

describe("GH #295: the shipped fixtures pass", () => {
  it("the Meridian Goods PRD-shaped narrative triage is valid, quotes verbatim", () => {
    const r = checkPrdTriage(MERIDIAN);
    expect(r).toMatchObject({ ok: true, storylines: 2, groups: 4, statements: 12 });
  });

  it("the synthetic spec with a Walkthroughs section is valid, quotes verbatim", () => {
    const r = checkPrdTriage(LIBRARY);
    expect(r).toMatchObject({ ok: true, storylines: 2, groups: 3, statements: 6 });
  });

  it("--source overrides the declared source", () => {
    expect(checkPrdTriage(LIBRARY, { source: LIBRARY_SRC }).ok).toBe(true);
    const wrong = checkPrdTriage(LIBRARY, { source: MERIDIAN_SRC });
    expect(wrong.ok).toBe(false);
  });
});

describe("GH #295: verbatim quotes (the LLM may reword, never invent)", () => {
  it("rejects a statement quote that does not appear in the source", () => {
    const e = errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.statements[0].quote = "A customer teleports an order")));
    expect(e.join("\n")).toContain("S1: quote does not appear verbatim");
  });

  it("rejects a storyline source span that is not in the source", () => {
    const e = errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.storylines[1].quote = "Invented journey")));
    expect(e.join("\n")).toContain("storylines[1] L2: quote does not appear verbatim");
  });

  it("tolerates differing whitespace and line wrapping", () => {
    expect(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.statements[1].quote = "When payment succeeds   the warehouse\n picks and packs the order")).ok).toBe(true);
  });

  it("reports a missing source document", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-triage-"));
    try {
      writeFileSync(join(dir, "t.json"), readFileSync(MERIDIAN));
      const r = checkPrdTriage(join(dir, "t.json"));
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toContain("source document not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GH #295: shape, rubric version, group and outcome", () => {
  it("rejects a wrong schema version and a stale rubric version", () => {
    const e = errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => ((d.prdTriageSchemaVersion = "2.0"), (d.rubricVersion = "0.9"))));
    expect(e.join("\n")).toContain(`prdTriageSchemaVersion must be "${PRD_TRIAGE_SCHEMA_VERSION}"`);
    expect(e.join("\n")).toContain(`rubricVersion must be "${PRD_RUBRIC.rubricVersion}"`);
  });

  it("requires exactly one main storyline", () => {
    expect(errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.storylines[0].main = false))).join("\n")).toContain("exactly one storyline must be main (found 0)");
    expect(errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.storylines[1].main = true))).join("\n")).toContain("(found 2)");
  });

  it("requires every statement to have a category and an outcome", () => {
    const e = errorsOf(
      mutated(MERIDIAN, MERIDIAN_SRC, (d) => {
        delete d.statements[0].category;
        delete d.statements[1].outcome;
      }),
    ).join("\n");
    expect(e).toContain("S1: category must be one of");
    expect(e).toContain("S2: outcome must be one of");
  });

  it("requires a modeled or rewritten statement to name a declared group and storyline", () => {
    const e = errorsOf(
      mutated(MERIDIAN, MERIDIAN_SRC, (d) => {
        d.statements[0].group = null;
        d.statements[1].group = "G99";
        d.statements[2].storyline = null;
      }),
    ).join("\n");
    expect(e).toContain("S1: outcome modeled needs a group");
    expect(e).toContain("S2: outcome modeled needs a group");
    expect(e).toContain("S3: outcome modeled needs a storyline");
  });

  it("keeps constraint/parked/question statements out of slice groups", () => {
    expect(errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.statements[6].group = "G1"))).join("\n")).toContain("S7: outcome constraint must have group null");
  });

  it("flags a group no statement joins and a duplicate id", () => {
    const e = errorsOf(
      mutated(MERIDIAN, MERIDIAN_SRC, (d) => {
        d.groups.push({ id: "G5", name: "Empty", trigger: "t", actor: "a", storyline: "L1" });
        d.statements[1].id = "S1";
      }),
    ).join("\n");
    expect(e).toContain("group G5: no statement joins it");
    expect(e).toContain("S1: duplicate id");
  });

  it("holds the rubric rules: outcomes per category, endpoints never modeled, business check, low confidence", () => {
    const e = errorsOf(
      mutated(MERIDIAN, MERIDIAN_SRC, (d) => {
        d.statements[8].outcome = "modeled"; // nfr -> modeled
        d.statements[9].outcome = "modeled"; // resource-or-endpoint -> modeled
        d.statements[0].aboutBusiness = false; // modeled but not about the business
        d.statements[1].confidence = "low"; // low confidence but not a question
      }),
    ).join("\n");
    expect(e).toContain("S9: category nfr may not have outcome modeled");
    expect(e).toContain("S10: category resource-or-endpoint may not have outcome modeled");
    expect(e).toContain("S10: a resource-or-endpoint statement is never modeled as-is");
    expect(e).toContain("S1: aboutBusiness is false but outcome is modeled");
    expect(e).toContain("S2: low confidence must become a question");
  });

  it("needs rewrite / reason / question text and constraint bookkeeping", () => {
    const e = errorsOf(
      mutated(MERIDIAN, MERIDIAN_SRC, (d) => {
        delete d.statements[7].rewrite;
        delete d.statements[11].reason;
        delete d.statements[10].question;
        d.constraints = [];
      }),
    ).join("\n");
    expect(e).toContain("S8: outcome rewritten needs a rewrite");
    expect(e).toContain("S12: outcome parked needs a reason");
    expect(e).toContain("S11: outcome question needs a question");
    expect(e).toContain("S7: outcome constraint but no constraints[] entry lists it");
  });

  it("rejects a constraint listing a non-constraint statement or an unknown one", () => {
    const e = errorsOf(mutated(MERIDIAN, MERIDIAN_SRC, (d) => (d.constraints[0].statements = ["S1", "S77"]))).join("\n");
    expect(e).toContain("statement S1 has outcome modeled, not constraint");
    expect(e).toContain('unknown statement "S77"');
  });

  it("rejects non-JSON, a non-object, and a missing file", () => {
    expect(validatePrdTriage([]).ok).toBe(false);
    expect(checkPrdTriage(join(ROOT, "no-such-triage.json")).errors[0]).toContain("no such file");
    expect(checkPrdTriage(MERIDIAN_SRC).errors[0]).toContain("not valid JSON");
  });

  it("--json envelope", () => {
    expect(JSON.parse(buildCheckPrdTriageJson(checkPrdTriage(LIBRARY)))).toMatchObject({ ok: true, statements: 6, errors: [] });
    expect(JSON.parse(buildCheckPrdTriageJson(checkPrdTriage(join(ROOT, "nope.json")))).ok).toBe(false);
  });
});

describe("GH #295: the Markdown view", () => {
  it("renders storylines, groups with statements, constraints, parked and questions", () => {
    const shape = validatePrdTriage(load(MERIDIAN));
    if (!shape.ok) throw new Error("fixture invalid");
    const md = renderPrdTriageMarkdown(shape.doc);
    expect(md).toContain("**Order to delivery** (main)");
    expect(md).toContain("### Pick Order");
    expect(md).toContain("Stock is decremented when a pick is confirmed.");
    expect(md).toContain("## Constraints (feed the constitution)");
    expect(md).toContain("Payments go through the Stripe API.");
    expect(md).toContain("Should partial shipments be supported?");
    expect(renderPrdTriageMarkdown(shape.doc)).toBe(md);
  });
});

describe("GH #295: em discover triage-check (CLI)", () => {
  it("prints ok and exits 0 for a valid record", () => {
    const r = em(["discover", "triage-check", MERIDIAN]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 storyline(s), 4 group(s), 12 statement(s), quotes verbatim");
  });

  it("--json and --markdown", () => {
    expect(JSON.parse(em(["discover", "triage-check", LIBRARY, "--json"]).stdout)).toMatchObject({ ok: true, statements: 6 });
    expect(em(["discover", "triage-check", LIBRARY, "--markdown"]).stdout).toContain("# PRD triage");
  });

  it("exits 1 and lists errors for an invented quote", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-triage-cli-"));
    try {
      cpSync(join(ROOT, "test", "fixtures", "prd-triage"), dir, { recursive: true });
      const d = load(join(dir, "library-triage.json"));
      d.statements[0].quote = "A member teleports a book.";
      writeFileSync(join(dir, "library-triage.json"), JSON.stringify(d));
      const r = em(["discover", "triage-check", join(dir, "library-triage.json")]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("quote does not appear verbatim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GH #295: the shipped rubric", () => {
  it("the skill bundle's data file is identical to the checker's rubric", () => {
    const text = readFileSync(join(DISCOVER, "reference", "prd-rubric.md"), "utf8");
    const m = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(PRD_RUBRIC);
    expect(text).toContain(`version ${PRD_RUBRIC.rubricVersion}`);
  });

  it("covers every category the issue names", () => {
    expect(PRD_RUBRIC.categories.map((c) => c.id).sort()).toEqual(
      ["actor", "business-fact", "business-rule", "external-system", "goal-background", "implementation-detail", "information-need", "nfr", "question", "resource-or-endpoint", "user-intent"],
    );
  });
});

describe("GH #295: skill text gates", () => {
  const skill = flat(join(DISCOVER, "SKILL.md"));
  const path = flat(join(DISCOVER, "reference", "prd-spec-path.md"));

  it("SKILL.md has the PRD/spec path section with the exact entry and opening message", () => {
    expect(skill).toContain("## Path: PRD or spec in");
    expect(skill).toContain("/event-modeling discover");
    expect(skill).toContain("Discover from this PRD/spec: <path to the document>");
    expect(skill).toContain("reference/prd-spec-path.md");
    expect(skill).toContain("em discover triage-check");
    expect(skill).toContain("Decisions log");
  });

  it("the reference names the same entry and walks steps 0 through 6", () => {
    expect(path).toContain("Discover from this PRD/spec: <path>");
    for (const h of ["## Step 0", "## Step 1", "## Step 2", "## Step 3", "## Step 4", "## Step 5", "## Step 6"]) expect(path).toContain(h);
  });

  it("states the load-bearing rules", () => {
    expect(path).toContain("main storyline");
    expect(path).toContain("secondary storyline");
    expect(path).toContain("verbatim");
    expect(path).toContain("is this about the business, independent of how it is built?");
    expect(path).toContain("never promoted to a command as-is");
    expect(path).toContain("Failure, retry and timeout statements are not new slices");
    expect(path).toContain("whose journey it advances");
    expect(path).toContain("Rewrite, don't drop");
    expect(path).toContain("constraints");
    expect(path).toContain("Decisions log");
    expect(path).toContain("Questions, never inventions");
    expect(path).toContain("discovery/prd-triage.json");
  });
});

describe("GH #295: docs", () => {
  it("docs/cli.md, docs/mcp.md and docs/ai-workflow.md document the path", () => {
    expect(readFileSync(join(ROOT, "docs", "cli.md"), "utf8")).toContain("## `em discover triage-check <file>`");
    expect(readFileSync(join(ROOT, "docs", "mcp.md"), "utf8")).toContain("### `discover_triage_check`");
    const wf = flat(join(ROOT, "docs", "ai-workflow.md"));
    expect(wf).toContain("## PRD or spec in");
    expect(wf).toContain("Discover from this PRD/spec: <path>");
  });
});
