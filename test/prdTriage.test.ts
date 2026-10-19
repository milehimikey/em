// SPDX-License-Identifier: MIT
// GH #295: the PRD/spec discovery path. Covers the deterministic checker (src/cli/prdTriage.ts,
// `em discover triage-check`) on the Meridian Goods eval input (examples/prd-triage) and a
// synthetic API spec with a Walkthroughs section (test/fixtures/prd-triage), the shipped rubric's
// parity with the skill bundle's data file and table, and grep gates on the skill text (the path is
// prose an agent follows, so the gate is that the required instructions exist and agree with the
// eval protocol's arm C).
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_QUOTE_CHARS,
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
const MERIDIAN_DIR = join(ROOT, "examples", "prd-triage");
const MERIDIAN = join(MERIDIAN_DIR, "prd-triage.json");
const MERIDIAN_SRC = join(ROOT, "eval", "inputs", "meridian-goods", "input.md");
const LIBRARY = join(ROOT, "test", "fixtures", "prd-triage", "library-triage.json");
const LIBRARY_SRC = join(ROOT, "test", "fixtures", "prd-triage", "library-api-spec.md");
const DISCOVER = join(ROOT, ".claude", "skills", "event-modeling-discover");
const EVAL_README = join(ROOT, "eval", "README.md");

function em(args: string[], cwd = ROOT) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Strip Markdown marks and collapse wrapping so a required phrase matches however it is formatted. */
const flat = (p: string) => readFileSync(p, "utf8").replace(/[`*]/g, "").replace(/\s+/g, " ");
const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** Mutate a deep copy of a triage doc and validate it against its source text. */
function mutated(path: string, srcPath: string, fn: (d: any) => void) {
  const d = load(path);
  fn(d);
  return validatePrdTriage(d, readFileSync(srcPath, "utf8"));
}
const mer = (fn: (d: any) => void) => mutated(MERIDIAN, MERIDIAN_SRC, fn);
const lib = (fn: (d: any) => void) => mutated(LIBRARY, LIBRARY_SRC, fn);
function errorsOf(r: ReturnType<typeof validatePrdTriage>): string {
  return r.ok ? "" : r.errors.join("\n");
}
/** Turn statement `i` into a `question` outcome (no group) with its question text. */
function asQuestion(s: any) {
  s.outcome = "question";
  s.group = null;
  s.storyline = null;
  s.question = "Is this right? proposed: something";
}

describe("GH #295: the shipped fixtures pass their own checker", () => {
  it("Meridian Goods (the eval input) triage is valid, quotes verbatim, no reference-only groups", () => {
    expect(checkPrdTriage(MERIDIAN)).toMatchObject({ ok: true, storylines: 2, groups: 6, statements: 15, referenceOnlyGroups: [] });
  });

  it("the Meridian main storyline quote is the full walkthrough, not its first sentence", () => {
    const main = load(MERIDIAN).storylines.find((s: any) => s.main);
    expect(main.quote).toContain("Once an order is placed");
    expect(main.quote).toContain("This is not initiated by anyone in the company.");
  });

  it("every Meridian PRD claim is a statement: nothing in the numbered walkthrough is dropped", () => {
    const quotes: string[] = load(MERIDIAN).statements.map((s: any) => s.quote);
    for (const claim of [
      "places an order from the storefront",
      "records who ordered, what, and when",
      "a payment is requested for its total",
      "calls us back when a payment is captured",
      "We record the capture",
      "dashboard of open orders",
      "sees their order's status",
      "can cancel an order",
      "Cancelled orders drop off the staff dashboard",
    ]) {
      expect(quotes.some((q) => q.includes(claim)), claim).toBe(true);
    }
  });

  it("the synthetic spec with a Walkthroughs section is valid and reports its reference-only group", () => {
    expect(checkPrdTriage(LIBRARY)).toMatchObject({ ok: true, storylines: 2, groups: 5, statements: 9, referenceOnlyGroups: ["Correct Book Details"] });
  });

  it("the library spec's walkthrough claims are all statements (returns before the due date; removed from the catalog)", () => {
    const quotes: string[] = load(LIBRARY).statements.map((s: any) => s.quote);
    expect(quotes.some((q) => q.includes("returns it before the due date"))).toBe(true);
    expect(quotes.some((q) => q.includes("removed from the catalog"))).toBe(true);
  });

  it("the synthetic spec is labelled synthetic on its first line", () => {
    expect(readFileSync(LIBRARY_SRC, "utf8").split("\n")[0]).toBe("Note: synthetic spec, authored for em's tests.");
  });

  it("--source overrides the declared source", () => {
    expect(checkPrdTriage(LIBRARY, { source: LIBRARY_SRC }).ok).toBe(true);
    expect(checkPrdTriage(LIBRARY, { source: MERIDIAN_SRC }).ok).toBe(false);
  });
});

describe("GH #295: verbatim quotes (the LLM may reword, never invent)", () => {
  it("rejects a statement quote that does not appear in the source", () => {
    expect(errorsOf(mer((d) => (d.statements[0].quote = "A Customer teleports an order")))).toContain("S1: quote does not appear verbatim");
  });

  it("rejects a storyline source span that is not in the source", () => {
    expect(errorsOf(mer((d) => (d.storylines[1].quote = "Invented journey of the staff")))).toContain("storylines[1] L2: quote does not appear verbatim");
  });

  it("tolerates differing whitespace and line wrapping", () => {
    expect(mer((d) => (d.statements[8].quote = "Fulfillment Staff   see a dashboard\n of open orders: placed orders, with the capture time once paid.")).ok).toBe(true);
  });

  it("tolerates Markdown emphasis/code marks and smart quotes on either side", () => {
    expect(lib((d) => (d.statements[5].quote = "POST /loans creates a loan record in the loans table.")).ok).toBe(true);
    expect(lib((d) => (d.statements[1].quote = "When the **book** is on the _shelf_ the librarian checks it out to the member")).ok).toBe(true);
    expect(mer((d) => (d.statements[9].quote = "A Customer sees their order’s status on their account page: placed, payment requested, paid.")).ok).toBe(true);
  });

  it(`rejects a quote shorter than ${MIN_QUOTE_CHARS} characters, even though "order" is in the source`, () => {
    expect(MIN_QUOTE_CHARS).toBe(12);
    expect(errorsOf(mer((d) => (d.statements[0].quote = "order")))).toContain("S1: quote is shorter than 12 characters");
  });

  it("reports a missing source document", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-triage-"));
    try {
      writeFileSync(join(dir, "t.json"), readFileSync(LIBRARY));
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
    const e = errorsOf(mer((d) => ((d.prdTriageSchemaVersion = "2.0"), (d.rubricVersion = "0.9"))));
    expect(e).toContain(`prdTriageSchemaVersion must be "${PRD_TRIAGE_SCHEMA_VERSION}"`);
    expect(e).toContain(`rubricVersion must be "${PRD_RUBRIC.rubricVersion}"`);
  });

  it("requires exactly one main storyline", () => {
    expect(errorsOf(mer((d) => (d.storylines[0].main = false)))).toContain("exactly one storyline must be main (found 0)");
    expect(errorsOf(mer((d) => (d.storylines[1].main = true)))).toContain("(found 2)");
  });

  it("requires every statement to have a category, an outcome and a provenance", () => {
    const e = errorsOf(
      mer((d) => {
        delete d.statements[0].category;
        delete d.statements[1].outcome;
        delete d.statements[2].provenance;
      }),
    );
    expect(e).toContain("S1: category must be one of");
    expect(e).toContain("S2: outcome must be one of");
    expect(e).toContain("S3: provenance must be walkthrough or reference");
  });

  it("requires a modeled or rewritten statement to name a declared group and its group's storyline", () => {
    const e = errorsOf(
      mer((d) => {
        d.statements[0].group = null;
        d.statements[1].group = "G99";
        d.statements[2].storyline = null;
        d.statements[3].storyline = "L2";
      }),
    );
    expect(e).toContain("S1: outcome modeled needs a group");
    expect(e).toContain("S2: outcome modeled needs a group");
    expect(e).toContain("S3: outcome modeled needs a storyline");
    expect(e).toContain("S4: storyline L2 differs from its group G2's storyline L1");
  });

  it("keeps constraint/parked/question statements out of slice groups", () => {
    expect(errorsOf(lib((d) => (d.statements[7].group = "G1")))).toContain("S8: outcome constraint must have group null");
  });

  it("flags a group no statement joins and a duplicate id", () => {
    const e = errorsOf(
      mer((d) => {
        d.groups.push({ id: "G9", name: "Empty", trigger: "t", actor: "a", storyline: "L1" });
        d.statements[1].id = "S1";
      }),
    );
    expect(e).toContain("group G9: no statement joins it");
    expect(e).toContain("S1: duplicate id");
  });

  it("an endpoint is never modeled (category outcome rule)", () => {
    const e = errorsOf(
      lib((d) => {
        d.statements[5].outcome = "modeled";
      }),
    );
    expect(e).toContain("S6: category resource-or-endpoint may not have outcome modeled");
    expect(e).toContain("S6: a resource-or-endpoint statement is never modeled as-is");
  });

  it("rejects an outcome the category does not allow (nfr modeled)", () => {
    expect(errorsOf(lib((d) => ((d.statements[8].outcome = "modeled"), (d.statements[8].group = "G1"), (d.statements[8].storyline = "L1"))))).toContain(
      "S9: category nfr may not have outcome modeled",
    );
  });

  it("needs rewrite / reason / question text and constraint bookkeeping", () => {
    const e = errorsOf(
      lib((d) => {
        delete d.statements[5].rewrite;
        d.statements[8].outcome = "parked";
        asQuestion(d.statements[6]);
        delete d.statements[6].question;
        d.constraints = [];
      }),
    );
    expect(e).toContain("S6: outcome rewritten needs a rewrite");
    expect(e).toContain("S9: outcome parked needs a reason");
    expect(e).toContain("S7: outcome question needs a question");
    expect(e).toContain("S8: outcome constraint but no constraints[] entry lists it");
  });

  it("rejects a constraint listing a non-constraint statement or an unknown one", () => {
    const e = errorsOf(lib((d) => (d.constraints[0].statements = ["S1", "S77"])));
    expect(e).toContain("statement S1 has outcome modeled, not constraint");
    expect(e).toContain('unknown statement "S77"');
  });

  it("rejects non-JSON, a non-object, and a missing file", () => {
    expect(validatePrdTriage([]).ok).toBe(false);
    expect(checkPrdTriage(join(ROOT, "no-such-triage.json")).errors[0]).toContain("no such file");
    expect(checkPrdTriage(LIBRARY_SRC).errors[0]).toContain("not valid JSON");
  });

  it("--json envelope", () => {
    expect(JSON.parse(buildCheckPrdTriageJson(checkPrdTriage(LIBRARY)))).toMatchObject({ ok: true, statements: 9, referenceOnlyGroups: ["Correct Book Details"], errors: [] });
    expect(JSON.parse(buildCheckPrdTriageJson(checkPrdTriage(join(ROOT, "nope.json")))).ok).toBe(false);
  });
});

describe("GH #295: low confidence and disagreement are questions", () => {
  it("a low-confidence user-intent with outcome question passes", () => {
    expect(
      mer((d) => {
        d.statements[10].confidence = "low"; // S11 user-intent
        asQuestion(d.statements[10]);
        d.statements[11].group = "G6"; // S12 keeps G6 populated
      }).ok,
    ).toBe(true);
  });

  it("a low-confidence user-intent with outcome modeled fails", () => {
    expect(errorsOf(mer((d) => (d.statements[10].confidence = "low")))).toContain("S11: low confidence must become a question, not modeled");
  });

  it("aboutBusiness contradicting the category's expectation must be a question", () => {
    // business-fact expects true; the independent check says false
    const e = errorsOf(mer((d) => (d.statements[2].aboutBusiness = false)));
    expect(e).toContain("S3: aboutBusiness is false but category business-fact expects true");
    expect(e).toContain("must have outcome question");
    // implementation-detail expects false; the check says true
    const e2 = errorsOf(
      lib((d) => {
        d.statements[7].aboutBusiness = true;
      }),
    );
    expect(e2).toContain("S8: aboutBusiness is true but category implementation-detail expects false");
  });

  it("the same disagreement as a question carrying the proposed rewrite passes; the agreeing case may be rewritten", () => {
    expect(
      mer((d) => {
        d.statements[2].aboutBusiness = false;
        asQuestion(d.statements[2]);
        d.statements[2].question = "Is this a business fact? proposed: An order records who ordered, what, and when.";
      }).ok,
    ).toBe(true);
    // implementation-detail + aboutBusiness false agree, so `rewritten` is allowed directly
    expect(
      lib((d) => {
        Object.assign(d.statements[7], { outcome: "rewritten", group: "G2", storyline: "L1", rewrite: "The service runs as one deployable unit." });
        d.constraints = [{ id: "C2", text: "API availability 99.9%", statements: ["S9"] }];
      }).ok,
    ).toBe(true);
  });

  it("an `either` category (external-system) accepts both answers", () => {
    expect(mer((d) => (d.statements[5].aboutBusiness = false)).ok).toBe(true);
  });

  it("question and parked are allowed for every category", () => {
    for (const c of PRD_RUBRIC.categories) {
      expect(c.outcomes, c.id).toContain("question");
      expect(c.outcomes, c.id).toContain("parked");
    }
  });

  it("an explicitly deferred intent may be parked with a reason", () => {
    expect(
      mer((d) => {
        Object.assign(d.statements[10], { outcome: "parked", group: null, storyline: null, reason: "Cancellation is deferred to a later release." });
        d.statements[11].group = "G6";
      }).ok,
    ).toBe(true);
  });
});

describe("GH #295: walkthrough-first provenance", () => {
  it("fails an anchored group with no walkthrough statement inside its storyline's span", () => {
    // main storyline quote cut to its first sentence: G2/G3's walkthrough statements fall outside the span
    const e = errorsOf(mer((d) => (d.storylines[0].quote = "A Customer places an order from the storefront (items, quantities, prices, total).")));
    expect(e).toContain("group G2: no walkthrough statement lies inside storyline L1's span");
    expect(e).toContain("group G3: no walkthrough statement lies inside storyline L1's span");
  });

  it("a reference-only group that names a storyline is rejected (group and statements)", () => {
    const e = errorsOf(
      lib((d) => {
        d.groups[4].storyline = "L2";
        d.statements[6].storyline = "L2";
      }),
    );
    expect(e).toContain("group G5: every statement is reference, so it is a reference-only group and must have storyline null");
  });

  it("a reference-only group's statements must also have storyline null", () => {
    expect(errorsOf(lib((d) => (d.statements[6].storyline = "L2")))).toContain("S7: its group G5 is reference-only (storyline null), so the statement's storyline must be null");
  });

  it("a group with walkthrough statements and storyline null is rejected", () => {
    expect(errorsOf(lib((d) => ((d.groups[0].storyline = null), (d.statements[0].storyline = null))))).toContain("group G1: storyline is null but it has walkthrough statements");
  });

  it("a walkthrough statement quoting text outside every storyline span is rejected", () => {
    const e = errorsOf(lib((d) => (d.statements[6].provenance = "walkthrough")));
    expect(e).toContain("S7: provenance is walkthrough but its quote lies inside no storyline's span");
  });

  it("a reference statement quoting text inside a storyline span is rejected", () => {
    const e = errorsOf(lib((d) => (d.statements[0].provenance = "reference")));
    expect(e).toContain("S1: provenance is reference but its quote lies inside storyline L1's span");
  });

  it("two statements may not share a quote; the error names both", () => {
    const e = errorsOf(lib((d) => (d.statements[3].quote = "A member reserves a book.")));
    expect(e).toContain("S4: quote duplicates statement S1's");
  });

  it("a question may name the group it would join (S7 in the reference-only group)", () => {
    const s7 = load(LIBRARY).statements[6];
    expect(s7).toMatchObject({ confidence: "low", outcome: "question", group: "G5", storyline: null });
  });

  it("nfr and external-system both expect `either`", () => {
    for (const id of ["nfr", "external-system"]) expect(PRD_RUBRIC.categories.find((c) => c.id === id)?.aboutBusiness).toBe("either");
    expect(mer(() => {}).ok).toBe(true);
    expect(lib((d) => (d.statements[8].aboutBusiness = true)).ok).toBe(true);
  });


  it("a group of only reference statements passes and is listed as reference-only", () => {
    const r = lib(() => {});
    expect(r.ok && r.referenceOnlyGroups).toEqual(["Correct Book Details"]);
    const result = checkPrdTriage(LIBRARY);
    expect(result.ok && result.referenceOnlyGroups).toEqual(["Correct Book Details"]);
  });

  it("a group with a walkthrough statement inside its span passes unflagged", () => {
    const r = mer(() => {});
    expect(r.ok && r.referenceOnlyGroups).toEqual([]);
  });

  it("the report text names the reference-only groups and why to look", () => {
    const out = em(["discover", "triage-check", LIBRARY]).stdout;
    expect(out).toContain("reference-only groups — operations no walkthrough touches; check these are not CRUD fill:");
    expect(out).toContain("  - Correct Book Details");
  });
});

describe("GH #295: the Markdown view", () => {
  it("renders storylines, groups with statements, constraints, parked, questions and reference-only groups", () => {
    const shape = validatePrdTriage(load(LIBRARY));
    if (!shape.ok) throw new Error("fixture invalid");
    const md = renderPrdTriageMarkdown(shape.doc, shape.referenceOnlyGroups);
    expect(md).toContain("**Borrow and return a book** (main)");
    expect(md).toContain("### Check Out Book");
    expect(md).toContain("A librarian checks a book out to a member.");
    expect(md).toContain("## Constraints (feed the constitution)");
    expect(md).toContain("API availability 99.9%");
    expect(md).toContain("## Reference-only groups — operations no walkthrough touches; check these are not CRUD fill");
    expect(md).toContain("- Correct Book Details");
    expect(renderPrdTriageMarkdown(shape.doc, shape.referenceOnlyGroups)).toBe(md);
  });
});

describe("GH #295: em discover triage-check (CLI)", () => {
  it("prints ok, with the source relative to the working directory, and exits 0", () => {
    const r = em(["discover", "triage-check", "prd-triage.json"], MERIDIAN_DIR);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok — prd-triage.json: 2 storyline(s), 6 group(s), 15 statement(s), quotes verbatim in ../../eval/inputs/meridian-goods/input.md");
  });

  it("the docs/cli.md example prints exactly that line", () => {
    expect(readFileSync(join(ROOT, "docs", "cli.md"), "utf8")).toContain(
      "# -> ok — prd-triage.json: 2 storyline(s), 6 group(s), 15 statement(s), quotes verbatim in ../../eval/inputs/meridian-goods/input.md",
    );
  });

  it("--json (absolute source) and --markdown", () => {
    const j = JSON.parse(em(["discover", "triage-check", LIBRARY, "--json"]).stdout);
    expect(j).toMatchObject({ ok: true, statements: 9, source: LIBRARY_SRC });
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
  const text = readFileSync(join(DISCOVER, "reference", "prd-rubric.md"), "utf8");

  it("the skill bundle's data file is identical to the checker's rubric", () => {
    const m = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(PRD_RUBRIC);
    expect(text).toContain(`version ${PRD_RUBRIC.rubricVersion}`);
  });

  it("the human-readable table matches the JSON (id, meaning, aboutBusiness, outcomes)", () => {
    const rows = text
      .split("\n")
      .filter((l) => /^\| `[a-z-]+` \|/.test(l))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    expect(rows.map((r) => r[0].replace(/`/g, ""))).toEqual(PRD_RUBRIC.categories.map((c) => c.id));
    for (const [i, c] of PRD_RUBRIC.categories.entries()) {
      expect(rows[i][1], c.id).toBe(c.meaning);
      expect(rows[i][2], c.id).toBe(String(c.aboutBusiness));
      expect(rows[i][3].split(", "), c.id).toEqual(c.outcomes);
    }
  });

  it("covers every category the issue names", () => {
    expect(PRD_RUBRIC.categories.map((c) => c.id).sort()).toEqual(
      ["actor", "business-fact", "business-rule", "external-system", "goal-background", "implementation-detail", "information-need", "nfr", "question", "resource-or-endpoint", "user-intent"],
    );
  });

  it("the text the agent reads states every checker rule", () => {
    const t = text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    for (const phrase of [
      "Disagreement is a question",
      "Low confidence is a question",
      "An endpoint is never modeled as-is",
      "Only modeled and rewritten statements join a slice group",
      "group: null",
      "Provenance",
      "reference-only group",
      "at least 12 characters",
      "full walkthrough span",
    ]) {
      expect(t, phrase).toContain(phrase);
    }
  });
});

describe("GH #295: skill text gates and the eval protocol's arm C", () => {
  const skill = flat(join(DISCOVER, "SKILL.md"));
  const path = flat(join(DISCOVER, "reference", "prd-spec-path.md"));
  const evalReadme = flat(EVAL_README);
  const ENTRY = "/em:discover (plugin) or /event-modeling discover (repo skills)";
  const OPENING = "Discover from this PRD/spec: <path>";

  it("SKILL.md has the PRD/spec path section with both entry forms and the opening message", () => {
    expect(skill).toContain("## Path: PRD or spec in");
    expect(skill).toContain(ENTRY);
    expect(skill).toContain(OPENING);
    expect(skill).toContain("reference/prd-spec-path.md");
    expect(skill).toContain("em discover triage-check");
    expect(skill).toContain("Decisions log");
  });

  it("the reference and docs/ai-workflow.md state the same two entry forms", () => {
    expect(path).toContain(ENTRY);
    expect(path).toContain(OPENING);
    const wf = flat(join(ROOT, "docs", "ai-workflow.md"));
    expect(wf).toContain("## PRD or spec in");
    expect(wf).toContain("/em:discover (plugin) or /event-modeling discover (repo skills)");
    expect(wf).toContain(OPENING);
  });

  it("eval/README.md arm C quotes the skill's entry and opening message word for word", () => {
    expect(evalReadme).toContain("/em:discover Discover from this PRD/spec: input.md.");
    expect(evalReadme).toContain(ENTRY);
    expect(evalReadme).toContain("with the opening message Discover from this PRD/spec: <path>");
  });

  it("the reference walks steps 0 through 6", () => {
    for (const h of ["## Step 0", "## Step 1", "## Step 2", "## Step 3", "## Step 4", "## Step 5", "## Step 6"]) expect(path).toContain(h);
  });

  it("states the load-bearing rules", () => {
    expect(path).toContain("main storyline");
    expect(path).toContain("secondary storyline");
    expect(path).toContain("verbatim");
    expect(path).toContain("full walkthrough span");
    expect(path).toContain("provenance");
    expect(path).toContain("Every claim in a walkthrough gets a statement");
    expect(path).toContain("is this about the business, independent of how it is built?");
    expect(path).toContain("never promoted to a command as-is");
    expect(path).toContain("Failure, retry and timeout statements are not new slices");
    expect(path).toContain("whose journey it advances");
    expect(path).toContain("Rewrite, don't drop");
    expect(path).toContain("Is this a business fact? proposed:");
    expect(path).toContain("Decisions log");
    expect(path).toContain("unchecked");
    expect(path).toContain("discovery/walkthroughs.md");
    expect(path).toContain("storyline: null");
    expect(path).toContain("reference-only groups");
    expect(path).toContain("Questions, never inventions");
    expect(path).toContain("discovery/prd-triage.json");
  });
});

describe("GH #295: docs", () => {
  it("docs/cli.md, docs/mcp.md document the checker, including the unchecked Decisions-log caveat", () => {
    const cli = readFileSync(join(ROOT, "docs", "cli.md"), "utf8");
    expect(cli).toContain("## `em discover triage-check <file>`");
    expect(cli.replace(/\s+/g, " ")).toContain("the Decisions-log entry for each parked or rejected statement was written: that entry is prose in the state file and is unchecked");
    expect(readFileSync(join(ROOT, "docs", "mcp.md"), "utf8")).toContain("### `discover_triage_check`");
  });
});
