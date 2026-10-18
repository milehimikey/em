// SPDX-License-Identifier: MIT
// GH #277: `storyline "Name" [source "url"] [after "Other"] { slice … }` — parser, the composed
// timeline `after` reads (validate + from/again resolution), export, query, `em slice index`, the
// band render and the `--storyline` subset render.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, ParseError } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { resolveFromSource, semanticEdges } from "../src/model/edges.js";
import { validate } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { compile } from "../src/pipeline.js";
import { buildExportDoc } from "../src/emit/json.js";
import { compileForQuery } from "../src/query/pipeline.js";
import { buildQuerySystem } from "../src/query/system.js";
import { querySlices } from "../src/query/verbs.js";
import { buildSliceIndexTable } from "../src/cli/sliceIndex.js";
import { composeSvg, layoutDot } from "../src/render/render.js";
import { buildStorylineDiagram, resolveStorylineArg } from "../src/render/storylineDiagram.js";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { storylineRuns } from "../src/model/storylines.js";

const modelFrom = (src: string) => normalize(parse(src));
const diagsFor = (src: string) => {
  const model = modelFrom(src);
  return validate(model, layout(model), computeRefs(model));
};
const exportDocOf = (src: string) => {
  const { model, refs, diagnostics } = compile(src);
  return buildExportDoc(model, refs, diagnostics, src, "stock.em").doc;
};
const codes = (src: string) => diagsFor(src).map((d) => d.code);

// Main journey + an unrelated storyline declared in between + a follow-up `after` the main one.
// Fully wired at both ends so the only diagnostics are the ones under test.
const THREE = `model "Stock"

context Inventory

storyline "Main" source "docs/stock.md#one" {
  slice "Receive" {
    ui Goods In @Clerk
    command Receive Stock
    event Stock Received @Inventory
  }
  slice "Catalog" {
    view Availability from "Stock Received"
    ui Stock Screen @Clerk
  }
}

storyline "Other" {
  slice "Adjust" {
    ui Adjust Form @Clerk
    command Adjust Stock
    event Stock Adjusted @Inventory
  }
  slice "Recount" {
    view Availability again from "Stock Adjusted"
    ui Recount Screen @Clerk
  }
}

storyline "Follow" after "Main" {
  slice "Watch" {
    automation Low Stock Alert from "Availability"
    command Raise Alert
    event Alert Raised @Inventory
  }
  slice "Alerts" {
    view Alert Board from "Alert Raised"
    ui Alert Screen @Clerk
  }
}
`;

describe("parser: storyline blocks", () => {
  it("groups slices, records source/after and keeps slices in file order", () => {
    const ast = parse(THREE);
    expect(ast.slices.map((s) => s.name)).toEqual(["Receive", "Catalog", "Adjust", "Recount", "Watch", "Alerts"]);
    expect(ast.slices.map((s) => s.storyline)).toEqual(["Main", "Main", "Other", "Other", "Follow", "Follow"]);
    expect(ast.storylines.map((s) => [s.name, s.source, s.after, s.sliceNames])).toEqual([
      ["Main", "docs/stock.md#one", undefined, ["Receive", "Catalog"]],
      ["Other", undefined, undefined, ["Adjust", "Recount"]],
      ["Follow", undefined, "Main", ["Watch", "Alerts"]],
    ]);
  });

  it("accepts source and after in either order, and an unquoted name", () => {
    const a = parse(`storyline "S" after "T" source "u" {\n slice "x" {\n }\n}\n`).storylines[0];
    expect([a.name, a.source, a.after]).toEqual(["S", "u", "T"]);
    const b = parse(`storyline Retire a product source "u" {\n}\n`).storylines[0];
    expect([b.name, b.source]).toEqual(["Retire a product", "u"]);
  });

  it("keeps a brace and the words source/after inside a quoted name or url", () => {
    const st = parse(`storyline "Sell after source" source "https://x/{id}" {\n}\n`).storylines[0];
    expect([st.name, st.source, st.after]).toEqual(["Sell after source", "https://x/{id}", undefined]);
  });

  it("allows slices outside any storyline", () => {
    const ast = parse(`storyline "S" {\n slice "a" {\n }\n}\nslice "b" {\n}\n`);
    expect(ast.slices.map((s) => s.storyline)).toEqual(["S", undefined]);
  });

  it("a second block with a declared name (case-insensitively) CONTINUES that storyline", () => {
    const ast = parse(`storyline "S" source "u" after "T" {\n slice "a" {\n }\n}\nstoryline "T" {\n slice "t" {\n }\n}\nstoryline "s" source "u" {\n slice "b" {\n }\n}\n`);
    expect(ast.storylines.map((s) => [s.name, s.sliceNames])).toEqual([["S", ["a", "b"]], ["T", ["t"]]]);
    expect(ast.slices.map((s) => s.storyline)).toEqual(["S", "T", "S"]);
  });

  it("a continuation block may not add or change source/after (storyline-clause-on-continuation)", () => {
    expect(() => parse(`storyline "S" source "u" {\n}\nstoryline "S" source "other" {\n}\n`)).toThrow(/storyline-clause-on-continuation/);
    expect(() => parse(`storyline "S" {\n}\nstoryline "S" after "T" {\n}\n`)).toThrow(/cannot add one/);
    expect(() => parse(`storyline "S" {\n}\nstoryline "S" source "x" {\n}\n`)).toThrow(ParseError);
  });

  it("rejects nesting, foreign declarations inside the block, and a missing close", () => {
    expect(() => parse(`storyline "A" {\n storyline "B" {\n}\n}\n`)).toThrow(/do not nest/);
    expect(() => parse(`storyline "A" {\n persona X\n}\n`)).toThrow(/not valid inside a storyline/);
    expect(() => parse(`storyline "A" {\n slice "x" {\n }\n`)).toThrow(/missing a closing/);
    expect(() => parse(`storyline "A"\n`)).toThrow(/must open a block/);
    expect(() => parse(`storyline "A" after "" {\n}\n`)).toThrow(/non-empty/);
  });
});

describe("validate: storyline rules", () => {
  it("is clean for a well-formed three-storyline model", () => {
    expect(diagsFor(THREE)).toEqual([]);
  });

  it("warns slice-outside-storyline once any storyline exists, and never otherwise", () => {
    const withStory = THREE + `slice "Loose" {\n  view Loose View from "Stock Received"\n  ui Loose Screen @Clerk\n}\n`;
    const diag = diagsFor(withStory).filter((d) => d.code === "slice-outside-storyline");
    expect(diag).toHaveLength(1);
    expect(diag[0].severity).toBe("warning");
    expect(diag[0].message).toContain('"Loose"');
    // No storyline at all: the advisory never fires.
    expect(codes(`slice "a" {\n  ui U @P\n  command C\n  event E\n}\nslice "b" {\n  view V from "E"\n  ui W @P\n}\n`)).not.toContain(
      "slice-outside-storyline",
    );
  });

  it("errors on an unknown `after` target and on cycles (including self)", () => {
    expect(codes(`storyline "A" after "Nope" {\n}\n`)).toContain("storyline-after-unknown");
    const cycle = codes(`storyline "A" after "B" {\n}\nstoryline "B" after "A" {\n}\n`);
    expect(cycle.filter((c) => c === "storyline-after-cycle")).toHaveLength(2);
    expect(codes(`storyline "A" after "A" {\n}\n`)).toContain("storyline-after-cycle");
  });

  it("`after` without a cycle is not a cycle (chains of three are fine)", () => {
    const c = codes(`storyline "A" {\n}\nstoryline "B" after "A" {\n}\nstoryline "C" after "B" {\n}\n`);
    expect(c).not.toContain("storyline-after-cycle");
    expect(c).not.toContain("storyline-after-unknown");
  });

  it("a reaction reads the referenced storyline's end state, not a sibling's instance in between", () => {
    const model = modelFrom(THREE);
    const reaction = model.elements.find((e) => e.name === "Low Stock Alert")!;
    const resolved = resolveFromSource(model, reaction, "Availability")!;
    expect(model.slices[resolved.sliceIndex].name).toBe("Catalog"); // Main's instance
    // Without `after`, file order alone picks the nearest earlier instance: Other's.
    const plain = modelFrom(THREE.replace(' after "Main"', ""));
    const r2 = plain.elements.find((e) => e.name === "Low Stock Alert")!;
    expect(plain.slices[resolveFromSource(plain, r2, "Availability")!.sliceIndex].name).toBe("Recount");
  });

  it("a view in the referenced storyline reading an event of the storyline after it is a backward feed", () => {
    // `Follow` is declared ABOVE `Main` yet comes after it: file order alone would call the event
    // earlier, the composed timeline calls it later.
    const src = `storyline "Follow" after "Main" {
  slice "Raise" {
    ui Raise Form @Clerk
    command Raise Alert
    event Alert Raised
  }
}
storyline "Main" {
  slice "Board" {
    view Alert Board from "Alert Raised"
    ui Alert Screen @Clerk
  }
}
`;
    const c = codes(src);
    expect(c).toContain("view-from-future-event");
  });

  it("a flow the composed timeline reads forward but the file draws right-to-left is storyline-after-out-of-order", () => {
    const src = `storyline "Follow" after "Main" {
  slice "Watch" {
    automation Low Stock Alert from "Availability"
    command Raise Alert
    event Alert Raised
  }
  slice "Alerts" {
    view Alert Board from "Alert Raised"
    ui Alert Screen @Clerk
  }
}
storyline "Main" {
  slice "Receive" {
    ui Goods In @Clerk
    command Receive Stock
    event Stock Received
  }
  slice "Catalog" {
    view Availability from "Stock Received"
    ui Stock Screen @Clerk
  }
}
`;
    const c = codes(src);
    expect(c).toContain("storyline-after-out-of-order");
    expect(c).not.toContain("reaction-from-future-view"); // the composed timeline resolves it
    // Same model without `after`: plain file order, the reaction reads a future view.
    expect(codes(src.replace(' after "Main"', ""))).toContain("reaction-from-future-view");
  });

  it("without `after`, file order is the only timeline (a later storyline's event stays a future event)", () => {
    const src = `storyline "A" {
  slice "Early" {
    view Board from "Late Event"
    ui Screen @Clerk
  }
}
storyline "B" {
  slice "Late" {
    ui Form @Clerk
    command Do Late
    event Late Event
  }
}
`;
    expect(codes(src)).toContain("view-from-future-event");
  });

  it("arrow-backward and loops-to-forward use the composed timeline", () => {
    const base = (after: string) => `storyline "Follow"${after} {
  slice "Raise" {
    ui Raise Form @Clerk
    command Raise Alert
    event Alert Raised
  }
  slice "Board" {
    view Alert Board from "Alert Raised"
    ui Alert Screen @Clerk
  }
}
storyline "Main" {
  slice "Receive" {
    ui Goods In @Clerk
    command Receive Stock
    event Stock Received
  }
  slice "Catalog" {
    view Availability from "Stock Received"
    ui Stock Screen @Clerk
  }
}
arrow Alert Board -> Goods In
`;
    // File order: Board (slice 2) -> Goods In (slice 3) is forward, fine.
    expect(codes(base(""))).not.toContain("arrow-backward");
    // `Follow` after `Main`: Goods In (Main) is earlier than Board (Follow) — the arrow points backward.
    expect(codes(base(' after "Main"'))).toContain("arrow-backward");
  });
});

describe("export, query and slice index", () => {
  it("export carries slice.storyline, model.storylines and schema 1.19", () => {
    const doc = exportDocOf(THREE);
    expect(doc.schemaVersion).toBe("1.19");
    expect(doc.model.slices.map((s) => s.storyline)).toEqual(["Main", "Main", "Other", "Other", "Follow", "Follow"]);
    expect(doc.model.storylines).toEqual([
      { name: "Main", source: "docs/stock.md#one", after: null, sliceKeys: ["receive", "catalog"] },
      { name: "Other", source: null, after: null, sliceKeys: ["adjust", "recount"] },
      { name: "Follow", source: null, after: "Main", sliceKeys: ["watch", "alerts"] },
    ]);
  });

  it("export of a model with no storylines has storyline: null and storylines: []", () => {
    const doc = exportDocOf(`slice "a" {\n  ui U @P\n  command C\n  event E\n}\nslice "b" {\n  view V from "E"\n  ui W @P\n}\n`);
    expect(doc.model.storylines).toEqual([]);
    expect(doc.model.slices.every((s) => s.storyline === null)).toBe(true);
  });

  it("em query slices --storyline filters, carries storyline, and errors on an unknown name", () => {
    const compiled = compileForQuery(THREE, ".");
    const system = buildQuerySystem([{ file: "stock.em", model: compiled.model, refs: compiled.refs, index: compiled.index }]);
    const res = querySlices(system, { storyline: "follow" });
    expect(res.ok && res.results.map((r) => [r.name, r.storyline])).toEqual([
      ["Watch", "Follow"],
      ["Alerts", "Follow"],
    ]);
    const bad = querySlices(system, { storyline: "Nope" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('"Main"');
    const all = querySlices(system, {});
    expect(all.ok && all.results).toHaveLength(6);
  });

  it("em slice index adds a Storyline column only for a model that declares storylines", () => {
    const withStories = compile(THREE);
    const table = buildSliceIndexTable(withStories.model, withStories.refs, ".");
    const lines = table.markdown.split("\n");
    expect(lines[0]).toContain("| Slice | Storyline | Pattern |");
    expect(lines[1].startsWith("|---|-------|-----------|")).toBe(true);
    expect(lines[2]).toContain("| 1 | Receive | Main | ");
    expect(lines[6]).toContain("| 5 | Watch | Follow | ");
    expect(table.rows.map((r) => r.storyline)).toEqual(["Main", "Main", "Other", "Other", "Follow", "Follow"]);

    const plain = compile(`slice "a" {\n  ui U @P\n  command C\n  event E\n}\n`);
    const plainTable = buildSliceIndexTable(plain.model, plain.refs, ".");
    expect(plainTable.markdown.split("\n")[0]).not.toContain("Storyline");
  });
});

describe("render: bands and the --storyline subset", () => {
  it("draws one labelled band per run of a storyline's columns above the header row", async () => {
    const { dot, model, grid } = compile(THREE);
    expect(grid.rows[0].band).toBe("storyline");
    expect(grid.rows[1].band).toBe("header");
    const svg = composeSvg(await layoutDot(dot), model, grid, ".", ".");
    expect((svg.match(/class="em-storyline-band"/g) ?? []).length).toBe(3);
    expect(svg).toContain('data-storyline="Main"');
    expect(svg).toContain(">Follow</text>");
    expect(svg).toContain("docs/stock.md#one"); // the source rides the band's tooltip
  });

  it("an interleaved storyline written in the DSL gets one band segment per run", async () => {
    const { model, dot, grid } = compile(`storyline "A" {
  slice "a1" {
    ui U1 @P
    command C1
    event E1
  }
}
storyline "B" {
  slice "b1" {
    view V1 from "E1"
    ui W1 @P
  }
}
storyline "A" {
  slice "a2" {
    ui U2 @P
    command C2
    event E2
  }
  slice "a3" {
    view V2 from "E2"
    ui W2 @P
  }
}
`);
    expect(model.storylines!.map((s) => [s.name, s.sliceIndexes])).toEqual([["A", [0, 2, 3]], ["B", [1]]]);
    expect(storylineRuns(model).map((r) => [r.storyline.name, r.fromCol, r.toCol])).toEqual([
      ["A", 0, 0],
      ["B", 1, 1],
      ["A", 2, 3],
    ]);
    const svg = composeSvg(await layoutDot(dot), model, grid, ".", ".");
    expect((svg.match(/class="em-storyline-band"/g) ?? []).length).toBe(3);
    expect(svg).toContain(">A (cont.)</text>");
  });

  it("`again` resolves on the composed timeline: B above A, B after A", () => {
    const src = `storyline "B" after "A" {
  slice "Later" {
    ui Later Form @Clerk
    command Later Do
    event Later Done
  }
  slice "Later View" {
    view Board again from "Later Done"
    ui Later Screen @Clerk
  }
}
storyline "A" {
  slice "First" {
    ui First Form @Clerk
    command First Do
    event First Done
  }
  slice "First View" {
    view Board from "First Done"
    ui First Screen @Clerk
  }
}
`;
    const model = modelFrom(src);
    const first = model.elements.find((e) => e.name === "Board" && !e.again)!;
    const again = model.elements.find((e) => e.name === "Board" && e.again)!;
    expect(again.logicalId).toBe(first.id);
    expect(first.logicalId).toBe(first.id);
    const c = codes(src);
    expect(c).not.toContain("view-again-without-earlier");
    // Plain file order (no `after`): the B instance is first, so its `again` has no earlier one.
    expect(codes(src.replace(' after "A"', ""))).toContain("view-again-without-earlier");
  });

  it("a model without storylines gets no band row and no band markup", async () => {
    const { dot, model, grid } = compile(`slice "a" {\n  ui U @P\n  command C\n  event E\n}\n`);
    expect(grid.rows.some((r) => r.band === "storyline")).toBe(false);
    const svg = composeSvg(await layoutDot(dot), model, grid, ".", ".");
    expect(svg).not.toContain("em-storyline-band");
  });

  it("--storyline: own slices in order, preceded by dimmed stub columns for what they read from outside", async () => {
    const { model } = compile(THREE);
    const found = resolveStorylineArg(model, "Follow");
    if ("error" in found) throw new Error(found.error);
    const sub = buildStorylineDiagram(model, found.storyline);
    // Main's end-state view (the reaction's `from`) is the only outside source: one stub column,
    // placed left of Follow's own two slices.
    expect(sub.model.slices.map((s) => [s.name, s.stub === true])).toEqual([
      ["Catalog", true],
      ["Watch", false],
      ["Alerts", false],
    ]);
    expect(sub.model.slices[0].elements.map((e) => e.name)).toEqual(["Availability"]); // only the referenced element
    // Other's instance is NOT the stub: the composed timeline resolves to Main's.
    const svg = composeSvg(await layoutDot(sub.dot), sub.model, sub.grid, ".", ".");
    expect(svg).toContain('opacity="0.4"');
    expect((svg.match(/class="em-storyline-band"/g) ?? []).length).toBe(1);
    expect(svg).toContain(">Follow</text>");
  });

  it("--storyline keeps stubs from between a storyline's blocks in timeline position (no right-to-left edge)", async () => {
    const src = `storyline "A" {
  slice "a1" {
    ui U1 @P
    command CA
    event EA
  }
}
storyline "B" {
  slice "b1" {
    view V from "EA"
    ui W1 @P
  }
  slice "b2" {
    ui U2 @P
    command CB
    event EB
  }
}
storyline "A" {
  slice "a2" {
    view V again from "EB"
    ui W2 @P
  }
}
`;
    const { model } = compile(src);
    const found = resolveStorylineArg(model, "A");
    if ("error" in found) throw new Error(found.error);
    const sub = buildStorylineDiagram(model, found.storyline);
    expect(sub.model.slices.map((sl) => [sl.name, sl.stub === true])).toEqual([
      ["a1", false],
      ["b1", true],
      ["b2", true],
      ["a2", false],
    ]);
    for (const e of semanticEdges(sub.model)) {
      const from = sub.model.byId.get(e.from)!;
      const to = sub.model.byId.get(e.to)!;
      expect(from.sliceIndex, `${from.name} -> ${to.name}`).toBeLessThanOrEqual(to.sliceIndex);
    }
    const svg = composeSvg(await layoutDot(sub.dot), sub.model, sub.grid, ".", ".");
    expect((svg.match(/class="em-storyline-band"/g) ?? []).length).toBe(2); // a1 | (stubs) | a2
  });

  it("storyline-after-out-of-order names the slice the storyline is declared above", () => {
    const src = `storyline "Follow" after "Main" {
  slice "Watch" {
    automation Low Alert from "Availability"
    command Raise Alert
    event Alert Raised
  }
}
storyline "Main" {
  slice "Catalog" {
    ui Goods In @Clerk
    command Receive Stock
    event Stock Received
  }
  slice "Board" {
    view Availability from "Stock Received"
    ui Stock Screen @Clerk
  }
}
`;
    const d = diagsFor(src).find((x) => x.code === "storyline-after-out-of-order")!;
    expect(d.message).toContain('declared above slice "Board" of "Main"');
    expect(d.message).toContain('move this storyline block below slice "Board"');
  });

  it("--storyline for a storyline with no outside reads has no stub columns", () => {
    const { model } = compile(THREE);
    const found = resolveStorylineArg(model, "Main");
    if ("error" in found) throw new Error(found.error);
    const sub = buildStorylineDiagram(model, found.storyline);
    expect(sub.model.slices.map((s) => s.name)).toEqual(["Receive", "Catalog"]);
    expect(sub.model.slices.some((s) => s.stub)).toBe(false);
  });

  it("--storyline names an unknown storyline in its error", () => {
    const { model } = compile(THREE);
    const res = resolveStorylineArg(model, "Nope");
    expect("error" in res && res.error).toContain('"Main", "Other", "Follow"');
    const none = resolveStorylineArg(compile(`slice "a" {\n  ui U @P\n  command C\n  event E\n}\n`).model, "x");
    expect("error" in none && none.error).toContain("no storylines");
  });

  it("the example model validates clean and renders bands plus each storyline alone", async () => {
    const src = readFileSync("examples/storylines.em", "utf8");
    const { dot, model, grid, diagnostics } = compile(src);
    expect(diagnostics).toEqual([]);
    const full = composeSvg(await layoutDot(dot), model, grid, "examples", ".");
    expect((full.match(/class="em-storyline-band"/g) ?? []).length).toBe(3);
    for (const st of model.storylines!) {
      const sub = buildStorylineDiagram(model, st);
      const svg = composeSvg(await layoutDot(sub.dot), sub.model, sub.grid, "examples", ".");
      expect(svg).toContain(`data-storyline="${st.name}"`);
    }
    // The `after` storyline carries the main storyline's end state as its dimmed stub.
    const retire = buildStorylineDiagram(model, model.storylines!.find((s) => s.name === "Retire a product")!);
    expect(retire.model.slices.filter((s) => s.stub).map((s) => s.name)).toEqual(["List Published Products"]);
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

describe("CLI: em render --storyline", () => {
  it("writes storylines/<slug>.svg next to the model by default and rejects --slice together", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-storyline-"));
    try {
      const em = (args: string[]) =>
        spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(join(dir, "m.em"), THREE);
      const ok = em(["render", "m.em", "--storyline", "Follow"]);
      expect(ok.status).toBe(0);
      expect(readFileSync(join(dir, "storylines", "follow.svg"), "utf8")).toContain("em-storyline-band");
      const both = em(["render", "m.em", "--storyline", "Follow", "--slice", "Watch"]);
      expect(both.status).toBe(1);
      expect(both.stderr).toContain("cannot be combined");
      const bad = em(["render", "m.em", "--storyline", "Nope"]);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("no storyline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
