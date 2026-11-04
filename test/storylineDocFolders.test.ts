// SPDX-License-Identifier: MIT
// GH #421 step 2 — a storyline model's slice docs live in its folder (`<dir>/slices/<key>.md`),
// found by key from the root (catalog/docLocate.ts); `em storyline split` moves them there.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { docFolders, locateDoc, docAbsPath } from "../src/catalog/docLocate.js";
import { docDirOf, sliceDocRel, docsDirs, parseDocPath } from "../src/model/sliceDocPath.js";
import { readSliceDoc } from "../src/catalog/readSliceDoc.js";
import { compileModelFile } from "../src/pipeline.js";
import { readSliceDocs } from "../src/render/sliceStatus.js";
import { buildSliceIndexTable } from "../src/cli/sliceIndex.js";
import { layoutDot, composeSvg } from "../src/render/render.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
const em = (dir: string, args: string[]) => spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

const ROOT_EM = `model "Shed"
persona Neighbor
context Loans
slice "Register" {
  ui Sign Up @Neighbor
  command Register Neighbor { neighborId: NeighborId } note "slices/register.md"
  event Neighbor Registered @Loans { neighborId: NeighborId }
}
storyline "Borrow and return a tool"
`;
const BORROW_EM = `storyline "Borrow and return a tool"

slice "Check Out Tool" {
  ui Checkout @Neighbor
  command Check Out Tool { loanId: LoanId } note "slices/check-out-tool.md"
  event Tool Checked Out @Loans { loanId: LoanId }
}
slice "My Loans" {
  view My Loans from "Tool Checked Out", "Neighbor Registered" { loanId: LoanId }
  ui Loans @Neighbor
}
`;
const DOC = (name: string, status = "draft") => `---\nschemaVersion: 1\npattern: state-change\nswimlane: Neighbor → Loans\nstatus: ${status}\nversion: 1\n---\n# Slice: ${name}\n\n![Diagram](./x.svg)\n\n## Intent\nx\n`;

describe("sliceDocPath helpers", () => {
  it("derive the doc dir from the declaring file", () => {
    expect(docDirOf({ file: undefined })).toBe("");
    expect(docDirOf({ file: "borrow-and-return-a-tool/borrow-and-return-a-tool.em" })).toBe("borrow-and-return-a-tool/");
    expect(sliceDocRel({ file: "stories/chase.em" }, "send-overdue-notice")).toBe("stories/slices/send-overdue-notice.md");
    expect(docsDirs({ slices: [{ file: undefined }, { file: "a/a.em" }, { file: "a/a.em" }, { file: "b/c/d.em" }] } as never)).toEqual(["slices", "a/slices", "b/c/slices"]);
    expect(parseDocPath("slices/pay.md")).toEqual({ dir: "", key: "pay" });
    expect(parseDocPath("a/slices/Pay-Order.md")).toEqual({ dir: "a/", key: "pay-order" });
    expect(parseDocPath("notes/pay.md")).toBeNull();
  });
});

describe("docs in storyline folders", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-doc-folders-"));
    writeFileSync(join(dir, "shed.em"), ROOT_EM);
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "register.md"), DOC("Register", "implemented"));
    mkdirSync(join(dir, "borrow-and-return-a-tool", "slices"), { recursive: true });
    writeFileSync(join(dir, "borrow-and-return-a-tool", "borrow-and-return-a-tool.em"), BORROW_EM);
    writeFileSync(join(dir, "borrow-and-return-a-tool", "slices", "check-out-tool.md"), DOC("Check Out Tool", "ready-to-implement"));
    mkdirSync(join(dir, "unrelated"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("docLocate sees the root and every folder with a slices/ dir, and finds a doc by key wherever it is", () => {
    expect(docFolders(dir)).toEqual(["", "borrow-and-return-a-tool/"]);
    expect(locateDoc(dir, "slices/register.md")).toBe(join(dir, "slices", "register.md"));
    expect(locateDoc(dir, "slices/check-out-tool.md")).toBe(join(dir, "borrow-and-return-a-tool", "slices", "check-out-tool.md"));
    expect(locateDoc(dir, "slices/nope.md")).toBeNull();
    expect(docAbsPath(dir, "slices/nope.md", { file: "borrow-and-return-a-tool/borrow-and-return-a-tool.em" })).toBe(join(dir, "borrow-and-return-a-tool", "slices", "nope.md"));
    expect(readSliceDoc(dir, "check-out-tool")?.status).toBe("ready-to-implement");
  });

  it("the export's doc join, the render's statuses and the README index all see the folder doc; the README links through the folder", async () => {
    const c = compileModelFile(join(dir, "shed.em"));
    expect(c.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const x = em(dir, ["export", "shed.em"]);
    const doc = JSON.parse(x.stdout);
    const byKey = Object.fromEntries(doc.model.slices.map((s: { key: string; doc: { status: string | null; path: string } }) => [s.key, s.doc]));
    expect(byKey["check-out-tool"]).toMatchObject({ status: "ready-to-implement", path: "slices/check-out-tool.md" }); // path stays relative to the declaring file
    expect(byKey["register"].status).toBe("implemented");
    expect(readSliceDocs(c.model, dir).map((d) => d?.status ?? null)).toEqual(["implemented", "ready-to-implement", null]);
    const table = buildSliceIndexTable(c.model, c.refs, dir);
    expect(table.rows.map((r) => r.docPath)).toEqual(["slices/register.md", "borrow-and-return-a-tool/slices/check-out-tool.md", null]);
    // the rendered SVG still composes with docs in folders (its status colouring read them)
    const svg = composeSvg(await layoutDot(c.dot), c.model, c.grid, dir, dir);
    expect(svg).toContain('class="em-status-legend"');
  });

  it("em slice sync, ratify and mark-implemented rewrite the doc where it is", () => {
    // sync found the folder doc and rewrote it there (it adopts the story line, GH #418)
    const sync = em(dir, ["slice", "sync", "shed.em", "check-out-tool"]);
    expect(sync.status, sync.stderr).toBe(0);
    expect(sync.stdout).toContain("synced: slices/check-out-tool.md");
    expect(readFileSync(join(dir, "borrow-and-return-a-tool", "slices", "check-out-tool.md"), "utf8")).toContain("<!-- GENERATED:em-slice-story:start");
    expect(existsSync(join(dir, "slices", "check-out-tool.md"))).toBe(false);
    const mi = em(dir, ["slice", "mark-implemented", "shed.em", "check-out-tool", "https://example.test/pr/1"]);
    expect(mi.status, mi.stderr).toBe(0);
    expect(readFileSync(join(dir, "borrow-and-return-a-tool", "slices", "check-out-tool.md"), "utf8")).toContain("status: implemented");
  });

  it("em slice new --wire puts a new doc into the slice's folder and writes a plain `slices/<key>.md` note into the storyline file", () => {
    const r = em(dir, ["slice", "new", "My Loans", "--pattern", "state-view", "--swimlane", "Neighbor → Loans", "--wire", "shed.em"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(dir, "borrow-and-return-a-tool", "slices", "my-loans.md"))).toBe(true);
    expect(existsSync(join(dir, "slices", "my-loans.md"))).toBe(false);
    expect(readFileSync(join(dir, "borrow-and-return-a-tool", "borrow-and-return-a-tool.em"), "utf8")).toContain('note "slices/my-loans.md"');
    expect(em(dir, ["validate", "shed.em"]).status).toBe(0);
  });
});

describe("em storyline split moves the story's docs", () => {
  it("each moved slice's doc and diagram end up in the storyline folder's slices/, and the model still reads them", () => {
    const d = mkdtempSync(join(tmpdir(), "em-split-docs-"));
    try {
      const src = readFileSync(join(ROOT, "examples", "storylines.em"), "utf8").replace('command Create Product { productId: UUID, name: string }', 'command Create Product { productId: UUID, name: string } note "slices/create-product.md"');
      writeFileSync(join(d, "storylines.em"), src);
      mkdirSync(join(d, "slices"));
      writeFileSync(join(d, "slices", "create-product.md"), DOC("Create Product"));
      writeFileSync(join(d, "slices", "create-product.svg"), "<svg/>");
      const r = em(d, ["storyline", "split", "storylines.em", "--storyline", "Bring a product to market"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("moved 2 doc/diagram file(s) into bring-a-product-to-market/slices/");
      expect(existsSync(join(d, "bring-a-product-to-market", "slices", "create-product.md"))).toBe(true);
      expect(existsSync(join(d, "bring-a-product-to-market", "slices", "create-product.svg"))).toBe(true);
      expect(existsSync(join(d, "slices", "create-product.md"))).toBe(false);
      const x = JSON.parse(em(d, ["export", "storylines.em"]).stdout);
      const cp = x.model.slices.find((s: { key: string }) => s.key === "create-product");
      expect(cp.doc.status).toBe("draft");
      expect(em(d, ["validate", "storylines.em"]).status).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});
