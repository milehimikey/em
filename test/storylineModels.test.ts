// SPDX-License-Identifier: MIT
// GH #421 step 1 — storyline models: a root declares `storyline "X" [after …]` with no body and the
// slices live in `<slug>/<slug>.em`; the root is the compile unit; `em storyline split` is the
// upgrade path.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse, parseStorylineFile, ParseError } from "../src/parser/parser.js";
import { loadModelAstFromText, ModelLoadError } from "../src/model/loadModel.js";
import { compile, compileModelFile, compileModelText } from "../src/pipeline.js";
import { planStorylineSplit } from "../src/cli/storylineSplit.js";
import { buildExport } from "../src/emit/json.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (dir: string, args: string[]) => spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

const ROOT_EM = `model "Shed"
persona Neighbor
context Loans

storyline "Join the shed" {
  slice "Register" {
    ui Sign Up @Neighbor
    command Register Neighbor { neighborId: NeighborId }
    event Neighbor Registered @Loans { neighborId: NeighborId }
  }
}

storyline "Borrow and return a tool" after "Join the shed"

storyline "Chase an overdue loan" after "Borrow and return a tool" in "stories/chase.em"
`;
const BORROW_EM = `storyline "Borrow and return a tool" source "docs/shed.md#borrow"

slice "Check Out Tool" {
  ui Checkout @Neighbor
  command Check Out Tool { loanId: LoanId }
  event Tool Checked Out @Loans { loanId: LoanId }
}
slice "My Loans" {
  view My Loans from "Tool Checked Out", "Neighbor Registered" { loanId: LoanId }
  ui Loans @Neighbor
}
`;
const CHASE_EM = `# the chase story
storyline "Chase an overdue loan"

slice "Overdue Loans To Notify" {
  view Overdue Loans To Notify from "Tool Checked Out" { loanId: LoanId }
}
slice "Send Overdue Notice" {
  processor Overdue Notifier from "Overdue Loans To Notify"
  command Send Overdue Notice { loanId: LoanId }
  event Overdue Notice Sent @Loans { loanId: LoanId }
}
slice "Notices" {
  view Sent Notices from "Overdue Notice Sent" { loanId: LoanId }
  ui Notices @Neighbor
}
`;
const files: Record<string, string> = { "borrow-and-return-a-tool/borrow-and-return-a-tool.em": BORROW_EM, "stories/chase.em": CHASE_EM };
const reader = (rel: string) => {
  if (!(rel in files)) throw new Error("ENOENT");
  return files[rel];
};

describe("parsing", () => {
  it("a `storyline` line without a body declares a storyline model with a default or explicit file and its timeline position", () => {
    const ast = parse(ROOT_EM);
    expect(ast.storylines.map((s) => [s.name, s.external === true, s.file, s.after, s.insertAt])).toEqual([
      ["Join the shed", false, undefined, undefined, undefined],
      ["Borrow and return a tool", true, "borrow-and-return-a-tool/borrow-and-return-a-tool.em", "Join the shed", 1],
      ["Chase an overdue loan", true, "stories/chase.em", "Borrow and return a tool", 1],
    ]);
  });

  it("refuses a block or a second declaration for a storyline model, and `in` on a block", () => {
    expect(() => parse(ROOT_EM + 'storyline "Chase an overdue loan" {\n  slice "X" {\n    command C\n  }\n}\n')).toThrow(/is a storyline model/);
    expect(() => parse(ROOT_EM + 'storyline "Chase an overdue loan"\n')).toThrow(/already declared/);
    expect(() => parse('storyline "A" in "a.em" {\n}\n')).toThrow(/belongs on a storyline declaration without/);
  });

  it("a storyline file is a header plus slices: `after`, `in`, a `{`, and root vocabulary are errors", () => {
    const parsed = parseStorylineFile(CHASE_EM);
    expect(parsed.header.name).toBe("Chase an overdue loan");
    expect(parsed.header.line).toBe(2);
    expect(parsed.slices.map((s) => [s.name, s.line])).toEqual([["Overdue Loans To Notify", 4], ["Send Overdue Notice", 7], ["Notices", 12]]);
    expect(parseStorylineFile(BORROW_EM).header.source).toBe("docs/shed.md#borrow");
    expect(() => parseStorylineFile('storyline "X" after "Y"\n')).toThrow(/`after` belongs on the root/);
    expect(() => parseStorylineFile('storyline "X" {\n}\n')).toThrow(/takes no `\{`/);
    expect(() => parseStorylineFile('persona P\nstoryline "X"\n')).toThrow(ParseError);
    expect(() => parseStorylineFile('storyline "X"\npersona P\n')).toThrow(/not valid inside a storyline/);
  });
});

describe("loading: the root is the compile unit", () => {
  it("splices each file's slices in at its declaration's position, tags them with their file, and merges the header's source", () => {
    const loaded = loadModelAstFromText(ROOT_EM, reader, "shed.em");
    expect(loaded.files).toEqual(["borrow-and-return-a-tool/borrow-and-return-a-tool.em", "stories/chase.em"]);
    expect(loaded.ast.slices.map((s) => [s.name, s.file ?? "root", s.storyline])).toEqual([
      ["Register", "root", "Join the shed"],
      ["Check Out Tool", "borrow-and-return-a-tool/borrow-and-return-a-tool.em", "Borrow and return a tool"],
      ["My Loans", "borrow-and-return-a-tool/borrow-and-return-a-tool.em", "Borrow and return a tool"],
      ["Overdue Loans To Notify", "stories/chase.em", "Chase an overdue loan"],
      ["Send Overdue Notice", "stories/chase.em", "Chase an overdue loan"],
      ["Notices", "stories/chase.em", "Chase an overdue loan"],
    ]);
    expect(loaded.ast.storylines[1].source).toBe("docs/shed.md#borrow");
    expect(loaded.hashSource).toContain("# -- file: stories/chase.em");
    const { model, diagnostics } = compileModelText(ROOT_EM, reader, "shed.em");
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(model.storylines!.map((s) => [s.name, s.file ?? null, s.sliceIndexes])).toEqual([
      ["Join the shed", null, [0]],
      ["Borrow and return a tool", "borrow-and-return-a-tool/borrow-and-return-a-tool.em", [1, 2]],
      ["Chase an overdue loan", "stories/chase.em", [3, 4, 5]],
    ]);
    // `from` resolves across files like across blocks
    expect(model.byName.get("overdue loans to notify")![0].from).toEqual(["Tool Checked Out"]);
  });

  it("refuses a missing file, a header that disagrees with the root, and a file outside the root's directory", () => {
    expect(() => loadModelAstFromText(ROOT_EM, (rel) => (rel === "stories/chase.em" ? CHASE_EM : (() => { throw new Error("x"); })()), "shed.em")).toThrow(ModelLoadError);
    expect(() => loadModelAstFromText(ROOT_EM, (rel) => (rel === "stories/chase.em" ? 'storyline "Something else"\n' : files[rel]), "shed.em")).toThrow(/declares storyline "Something else" but the root/);
    expect(() => loadModelAstFromText('storyline "A" in "../a.em"\n', reader)).toThrow(/outside the model's directory/);
  });

  it("a diagnostic about an element in a storyline file names that file; one about the root does not", () => {
    const chaseWithGap = CHASE_EM.replace('view Sent Notices from "Overdue Notice Sent" { loanId: LoanId }', 'view Sent Notices from "Overdue Notice Sent" { loanId: LoanId, missing: Text }');
    const { diagnostics } = compileModelText(ROOT_EM, (rel) => (rel === "stories/chase.em" ? chaseWithGap : files[rel]), "shed.em");
    const inChase = diagnostics.find((d) => d.message.includes('"missing"'));
    expect(inChase?.file).toBe("stories/chase.em");
    expect(diagnostics.filter((d) => d.file === undefined && d.line !== undefined).every((d) => !d.message.includes("missing"))).toBe(true);
  });

  it("compile() on a split root's text alone cannot see the storyline files — the root must be loaded as a file", () => {
    expect(() => compileModelText(ROOT_EM, () => { throw new Error("no"); }, "shed.em")).toThrow(ModelLoadError);
    // the plain text pipeline parses the declarations but gets no slices for them
    expect(compile(ROOT_EM).model.storylines!.map((s) => s.sliceIndexes.length)).toEqual([1, 0, 0]);
  });
});

describe("on disk: compileModelFile, export and em storyline split", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-storyline-models-"));
    writeFileSync(join(dir, "shed.em"), ROOT_EM);
    mkdirSync(join(dir, "borrow-and-return-a-tool"));
    writeFileSync(join(dir, "borrow-and-return-a-tool", "borrow-and-return-a-tool.em"), BORROW_EM);
    mkdirSync(join(dir, "stories"));
    writeFileSync(join(dir, "stories", "chase.em"), CHASE_EM);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("compiles the root with its files; export carries storylines[].file", () => {
    const c = compileModelFile(join(dir, "shed.em"));
    expect(c.files).toEqual(["borrow-and-return-a-tool/borrow-and-return-a-tool.em", "stories/chase.em"]);
    const doc = JSON.parse(buildExport(c.model, c.refs, c.diagnostics, c.source, "shed.em").text);
    expect(doc.model.storylines.map((s: { name: string; file: string | null }) => [s.name, s.file])).toEqual([
      ["Join the shed", null],
      ["Borrow and return a tool", "borrow-and-return-a-tool/borrow-and-return-a-tool.em"],
      ["Chase an overdue loan", "stories/chase.em"],
    ]);
  });

  it("em validate / em export work from the root and print a storyline file's diagnostics with the file", () => {
    const v = em(dir, ["validate", "shed.em"]);
    expect(v.status).toBe(0);
    const bad = CHASE_EM.replace("{ loanId: LoanId }\n}\nslice \"Send", "{ loanId: LoanId, missing: Text }\n}\nslice \"Send");
    writeFileSync(join(dir, "stories", "chase.em"), bad);
    const w = em(dir, ["validate", "shed.em"]);
    expect(w.stderr + w.stdout).toMatch(/warn :stories\/chase\.em:\d+ /);
    writeFileSync(join(dir, "stories", "chase.em"), CHASE_EM);
    const x = em(dir, ["export", "shed.em"]);
    expect(x.status).toBe(0);
    expect(JSON.parse(x.stdout).model.slices).toHaveLength(6);
  });

  it("em storyline split moves the example model's inline blocks into files and the export reads the same (only `file` differs)", () => {
    const exDir = mkdtempSync(join(tmpdir(), "em-split-"));
    try {
      const src = readFileSync(join(ROOT, "examples", "storylines.em"), "utf8");
      writeFileSync(join(exDir, "storylines.em"), src);
      const before = JSON.parse(em(exDir, ["export", "storylines.em"]).stdout);
      const dry = em(exDir, ["storyline", "split", "storylines.em", "--dry-run"]);
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("would write bring-a-product-to-market/bring-a-product-to-market.em");
      expect(existsSync(join(exDir, "bring-a-product-to-market"))).toBe(false);
      const r = em(exDir, ["storyline", "split", "storylines.em"]);
      expect(r.status, r.stderr).toBe(0);
      const root = readFileSync(join(exDir, "storylines.em"), "utf8");
      expect(root).toContain('storyline "Bring a product to market"\n');
      expect(root).toContain('storyline "Retire a product" after "Bring a product to market"\n');
      expect(root).not.toContain("{\n  slice");
      const bring = readFileSync(join(exDir, "bring-a-product-to-market", "bring-a-product-to-market.em"), "utf8");
      expect(bring.startsWith('storyline "Bring a product to market" source "docs/catalog.md#walkthrough-1"\n\nslice "Create Product" {\n  ui Product Form @Merchandiser\n')).toBe(true);
      const after = JSON.parse(em(exDir, ["export", "storylines.em"]).stdout);
      const strip = (d: { model: { storylines: { file: string | null }[] } }) => {
        const m = JSON.parse(JSON.stringify(d.model));
        for (const s of m.storylines) delete s.file;
        for (const sl of m.slices) { delete sl.line; for (const e of sl.elements) delete e.line; }
        return m;
      };
      expect(strip(after)).toEqual(strip(before));
      expect(after.model.storylines.map((s: { file: string | null }) => s.file)).toEqual([
        "bring-a-product-to-market/bring-a-product-to-market.em",
        "extend-an-attribute/extend-an-attribute.em",
        "retire-a-product/retire-a-product.em",
      ]);
      // a second split finds nothing left to do
      const again = em(exDir, ["storyline", "split", "storylines.em"]);
      expect(again.stdout).toContain("nothing to split");
    } finally {
      rmSync(exDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("the planner refuses a reopened storyline and leaves the rest alone", () => {
    const src = `storyline "A" {\n  slice "a1" {\n    ui U @P\n    command CA\n    event EA\n  }\n}\nstoryline "B" {\n  slice "b1" {\n    view V from "EA"\n    ui W @P\n  }\n}\nstoryline "A" {\n  slice "a2" {\n    view V again from "EA"\n    ui W2 @P\n  }\n}\n`;
    const { model } = compile(src);
    const plan = planStorylineSplit(model, src);
    expect(plan.skipped).toEqual([{ storyline: "A", reason: expect.stringContaining("declared in 2 blocks") }]);
    expect(plan.files.map((f) => f.path)).toEqual(["b/b.em"]);
    expect(plan.files[0].content).toBe('storyline "B"\n\nslice "b1" {\n  view V from "EA"\n  ui W @P\n}\n');
    expect(plan.rootText).toContain('\nstoryline "B"\nstoryline "A" {');
  });
});
