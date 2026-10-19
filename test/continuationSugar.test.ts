// SPDX-License-Identifier: MIT
// GH #287: continuations without ceremony — (a) several `again` views stack in one continuation
// slice's api cell, (b) `view X again` written inside a command's own slice synthesizes the
// continuation column right after it, (c) an unnamed continuation slice is auto-named
// "<View> View: <Event>". Neutral catalog domain.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser/parser.js";
import { compile } from "../src/pipeline.js";
import { continuationOf } from "../src/model/continuation.js";
import { buildExportDoc } from "../src/emit/json.js";
import { semanticEdges } from "../src/model/edges.js";
import { buildSliceIndexTable } from "../src/cli/sliceIndex.js";

// Hand-written baseline: every feeding command needs a named continuation per view (2N columns).
const HAND = `model "Catalog"
context Catalog
persona Admin

slice "Create Class" {
  ui Class Form @Admin
  command Create Class
  event Class Created @Catalog { classId: string }
}
slice "Classes" {
  view Product Classes from "Class Created" { classId: string }
  ui Class List @Admin
}
slice "Counts" {
  view Class Counts from "Class Created" { classId: string }
  ui Class List @Admin
}
slice "Rename Class" {
  ui Rename Form @Admin
  command Rename Class
  event Class Renamed @Catalog { classId: string }
}
slice {
  view Product Classes again from "Class Renamed"
  view Class Counts again from "Class Renamed"
  ui Class List @Admin
}
`;

// Same model, no ceremony: the sugar lines live in the command's slice.
const SUGAR = `model "Catalog"
context Catalog
persona Admin

slice "Create Class" {
  ui Class Form @Admin
  command Create Class
  event Class Created @Catalog { classId: string }
}
slice "Classes" {
  view Product Classes from "Class Created" { classId: string }
  ui Class List @Admin
}
slice "Counts" {
  view Class Counts from "Class Created" { classId: string }
  ui Class List @Admin
}
slice "Rename Class" {
  ui Rename Form @Admin
  command Rename Class
  event Class Renamed @Catalog { classId: string }
  view Product Classes again from "Class Renamed" shown on "Class List"
  view Class Counts again from "Class Renamed" shown on "Class List"
}
`;

const errors = (src: string) => compile(src).diagnostics.filter((d) => d.severity === "error");

describe("(c) auto-named continuation slices", () => {
  it("names an unnamed continuation slice \"<View> View: <Event>\"", () => {
    const ast = parse(`slice {\n  view Orders again from "Order Placed"\n  ui Order List\n}`);
    expect(ast.slices[0].name).toBe("Orders View: Order Placed");
  });

  it("joins several events with \", \"", () => {
    const ast = parse(`slice {\n  view Orders again from "Order Placed", "Order Paid"\n}`);
    expect(ast.slices[0].name).toBe("Orders View: Order Placed, Order Paid");
  });

  it("keeps an explicit name", () => {
    const ast = parse(`slice "Mine" {\n  view Orders again from "Order Placed"\n}`);
    expect(ast.slices[0].name).toBe("Mine");
  });

  it("still requires a name on any slice that is not a continuation", () => {
    expect(() => parse(`slice {\n  command Do Thing\n}`)).toThrow(/slice requires a name/);
  });

  it("derives a stable slice key from view + event", () => {
    const { refs } = compile(`context Sales
slice "Place" {
  command Place Order
  event Order Placed
}
slice "Show" {
  view Orders from "Order Placed"
  ui Order List
}
slice "Pay" {
  command Pay Order
  event Order Paid
}
slice {
  view Orders again from "Order Paid"
  ui Order List
}
`);
    expect(refs.sliceKeys[3]).toBe("orders-view-order-paid");
  });
});

describe("(a) several `again` views stack in one continuation slice", () => {
  const src = `model "Stack"
context Catalog
persona Admin
slice "Create" {
  command Create Class
  event Class Created @Catalog
}
slice "A" {
  view Product Classes from "Class Created"
  ui List A @Admin
}
slice "B" {
  view Class Counts from "Class Created"
  ui List B @Admin
}
slice "Rename" {
  command Rename Class
  event Class Renamed @Catalog
}
slice "Both Again" {
  view Product Classes again from "Class Renamed"
  view Class Counts again from "Class Renamed"
  ui List A @Admin
}
`;

  it("lays both views out in one column with no grid collision", () => {
    const { grid, diagnostics } = compile(src);
    expect(grid.collisions).toEqual([]);
    expect(diagnostics.filter((d) => d.code === "grid-collision")).toEqual([]);
    const col = 4;
    const stacked = grid.cells.map((row) => row[col]).filter((c) => c?.kind === "view");
    expect(stacked.map((c) => c!.name)).toEqual(["Product Classes", "Class Counts"]);
  });

  it("each instance keeps its own from and consumer edge", () => {
    const { model, edges } = compileEdges(src);
    const viewIds = model.slices[4].elements.filter((e) => e.kind === "view").map((e) => e.id);
    const ui = model.slices[4].elements.find((e) => e.kind === "ui")!;
    for (const id of viewIds) expect(edges.some((e) => e.from === id && e.to === ui.id)).toBe(true);
    expect(errors(src)).toEqual([]);
  });

  it("still never connects instances of the same view", () => {
    const { edges, model } = compileEdges(src);
    const views = model.elements.filter((e) => e.kind === "view");
    for (const e of edges) {
      const a = views.find((v) => v.id === e.from);
      const b = views.find((v) => v.id === e.to);
      expect(a && b).toBeFalsy();
    }
  });
});

function compileEdges(src: string) {
  const c = compile(src);
  return { model: c.model, edges: semanticEdges(c.model) };
}

const HAND2_SRC = `persona Admin
context Catalog
slice "Create" {
  command Create Class
  event Class Created @Catalog
}
slice "A" {
  view Product Classes from "Class Created"
  ui Class List @Admin
}
slice "B" {
  view Class Counts from "Class Created"
  ui Storefront @Admin
}
slice "Rename" {
  command Rename Class
  event Class Renamed @Catalog
}
slice {
  view Product Classes again from "Class Renamed"%A
  view Class Counts again from "Class Renamed"%B
  ui Class List @Admin
  ui Storefront @Admin
}
`;

const CONT = "Product Classes View: Class Renamed + Class Counts View: Class Renamed";

describe("(b) `view X again` inside a command's slice", () => {
  it("synthesizes ONE stacked continuation column right after the host slice", () => {
    const { model, refs } = compile(SUGAR);
    expect(model.slices.map((s) => s.name)).toEqual(["Create Class", "Classes", "Counts", "Rename Class", CONT]);
    expect(refs.sliceKeys.slice(3)).toEqual(["rename-class", "rename-class--again"]);
    expect(model.slices[4].synthesized).toEqual({ host: 3 });
    expect(model.slices[3].elements.some((e) => e.kind === "view")).toBe(false);
    expect(model.slices[4].elements.filter((e) => e.kind === "view")).toHaveLength(2);
  });

  it("PIM-shaped fixture: N columns, no hand-written names, every event->view edge spans one column", () => {
    const hand = compile(HAND);
    const { model } = compile(SUGAR);
    expect(model.slices.length).toBe(hand.model.slices.length);
    expect(errors(SUGAR)).toEqual([]);
    expect(errors(HAND)).toEqual([]);
    const col = (id: string) => model.byId.get(id)!.sliceIndex;
    for (const e of semanticEdges(model)) {
      const a = model.byId.get(e.from)!;
      const b = model.byId.get(e.to)!;
      if (a.kind === "event" && b.kind === "view" && b.again) expect(col(b.id) - col(a.id)).toBe(1);
    }
  });

  it("export continuationOf / alsoReads match the hand-written form", () => {
    const strip = (src: string) => {
      const c = compile(src);
      const exp = buildExportDoc(c.model, c.refs, c.diagnostics, src, join(tmpdir(), "em-287-none", "model.em")).doc as unknown as {
        model: { slices: { name: string; alsoReads?: { event: string; atSlice: string }[]; continuationOf?: string | null }[] };
      };
      const slices = exp.model.slices;
      return {
        classes: slices.find((s) => s.name === "Classes")!.alsoReads,
        counts: slices.find((s) => s.name === "Counts")!.alsoReads,
        cont: slices[slices.length - 1].continuationOf,
      };
    };
    const hand = strip(HAND);
    const sugar = strip(SUGAR);
    expect(sugar.cont).toBe(hand.cont);
    expect(sugar.cont).toBe("classes"); // the FIRST view's origin; the rest are listed in alsoReads
    expect(sugar.classes?.map((r) => r.event)).toEqual(hand.classes?.map((r) => r.event));
    expect(sugar.counts?.map((r) => r.event)).toEqual(hand.counts?.map((r) => r.event));
    expect(sugar.counts).toHaveLength(1);
    expect(sugar.classes?.[0].atSlice).toBe("rename-class--again");
  });

  it("the synthesized slice is a continuation of the first view's originating slice", () => {
    const { model, refs } = compile(SUGAR);
    expect(continuationOf(model, refs, 4)).toMatchObject({ sliceKey: "classes" });
  });

  it("consumer defaults to the host slice's ui, `shown on` names another", () => {
    const { model } = compile(SUGAR);
    const ui = model.slices[4].elements.find((e) => e.kind === "ui")!;
    expect(ui).toMatchObject({ name: "Class List", persona: "Admin" });
    const dflt = compile(SUGAR.replace(/ shown on "Class List"/g, ""));
    const ui2 = dflt.model.slices[4].elements.find((e) => e.kind === "ui")!;
    expect(ui2).toMatchObject({ name: "Rename Form", persona: "Admin" });
  });

  it("is absent from `em slice index` (and a hand-written continuation still gets its row)", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-287-"));
    try {
      const sugar = compile(SUGAR);
      expect(buildSliceIndexTable(sugar.model, sugar.refs, dir).rows.map((r) => r.name)).toEqual(["Create Class", "Classes", "Counts", "Rename Class"]);
      const hand = compile(HAND);
      expect(buildSliceIndexTable(hand.model, hand.refs, dir).rows).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every rule still holds: an unconsumed synthesized view warns, instances never connect", () => {
    const noUi = SUGAR.replace("  ui Rename Form @Admin\n", "").replace(/ shown on "Class List"/g, "");
    expect(compile(noUi).diagnostics.filter((d) => d.code === "both-ends-of-a-flow/view-unconsumed")).toHaveLength(2);
    const { model, edges } = compileEdges(SUGAR);
    const views = new Set(model.elements.filter((e) => e.kind === "view").map((e) => e.id));
    expect(edges.filter((e) => views.has(e.from) && views.has(e.to))).toEqual([]);
  });

  it("forward-only: an again line whose event comes later still errors", () => {
    const src = `context Sales
slice "Place" {
  command Place Order
  event Order Placed
}
slice "Show" {
  view Orders from "Order Placed"
  ui Order List
}
slice "Pay" {
  ui Pay Form
  command Pay Order
  event Order Paid
  view Orders again from "Order Cancelled"
}
slice "Cancel" {
  command Cancel Order
  event Order Cancelled
}
`;
    expect(errors(src).length).toBeGreaterThan(0);
  });

  it("a reaction's INPUT view (not fed by this slice's events) stays in its slice", () => {
    const { model } = compile(`context Orders
slice "A" {
  command Create Order
  event Order Created @Orders
  view Todo from "Order Created"
}
slice "B" {
  processor Ship On Todo from "Todo"
  command Ship Order
  event Order Shipped @Orders
  view Todo again from "Order Created"
}
`);
    expect(model.slices).toHaveLength(2);
  });

  it("a follow-on update of the reaction's view (fed by this slice's event) is lifted", () => {
    const src = `context Orders
slice "A" {
  command Create Order
  event Order Created @Orders
  view Orders from "Order Created"
  ui Order List
}
slice "Auto Ship" {
  processor Shipper from "Orders"
  command Ship Order
  event Order Shipped @Orders
  view Orders again from "Order Shipped" shown on "Order List"
}
`;
    const { model } = compile(src);
    expect(model.slices.map((s) => s.name)).toEqual(["A", "Auto Ship", "Orders View: Order Shipped"]);
    expect(model.slices[2].elements.map((e) => e.kind)).toEqual(["view", "ui"]);
  });

  const SCREENS = (secondPersona: string, secondLine: string) => `model "Screens"
context Catalog
persona Admin
persona Shopper
slice "Create Class" {
  ui Class Form @Admin
  command Create Class
  event Class Created @Catalog
}
slice "Classes" {
  view Product Classes from "Class Created"
  ui Class List @Admin
}
slice "Counts" {
  view Class Counts from "Class Created"
  ui Storefront @${secondPersona}
}
slice "Rename Class" {
  ui Rename Form @Admin
  command Rename Class
  event Class Renamed @Catalog
  view Product Classes again from "Class Renamed" shown on "Class List"
  ${secondLine}
}
`;
  const HAND2 = (a: string, b: string) => `${HAND2_SRC}`.replace("%A", a).replace("%B", b);
  const uiEdges = (src: string) => {
    const { model } = compile(src);
    const cont = model.slices[model.slices.length - 1];
    const ids = new Set(cont.elements.map((e) => e.id));
    return semanticEdges(model)
      .filter((e) => ids.has(e.from) && model.byId.get(e.to)?.kind === "ui")
      .map((e) => `${model.byId.get(e.from)!.name}>${model.byId.get(e.to)!.name}`)
      .sort();
  };

  it("two screens on two personas stack in their own ui lanes; each view wires only to its own screen", () => {
    const src = SCREENS("Shopper", 'view Class Counts again from "Class Renamed" shown on "Storefront"');
    expect(uiEdges(src)).toEqual(["Class Counts>Storefront", "Product Classes>Class List"]);
    expect(compile(src).diagnostics.filter((d) => d.code === "grid-collision")).toEqual([]);
    const cont = compile(src).model.slices.at(-1)!;
    expect(cont.elements.filter((e) => e.kind === "ui").map((e) => e.persona)).toEqual(["Admin", "Shopper"]);
  });

  it("two screens on the same persona: still no false view->ui edges", () => {
    const src = SCREENS("Admin", 'view Class Counts again from "Class Renamed" shown on "Storefront"');
    expect(uiEdges(src)).toEqual(["Class Counts>Storefront", "Product Classes>Class List"]);
    const c = compile(src);
    expect(c.diagnostics.filter((d) => d.code === "grid-collision")).toEqual([]);
    const col = c.model.slices.length - 1;
    const rowsWithUi = c.grid.rows.filter((_r, i) => c.grid.cells[i][col]?.kind === "ui").map((r) => r.key);
    expect(rowsWithUi).toEqual(["ui:Admin", "ui:Admin:2"]);
  });

  it("a hand-written stacked continuation with two same-persona screens stacks them too", () => {
    const c = compile(HAND2(' shown on "Class List"', ' shown on "Storefront"'));
    expect(c.diagnostics.filter((d) => d.code === "grid-collision")).toEqual([]);
    expect(uiEdges(HAND2(' shown on "Class List"', ' shown on "Storefront"'))).toEqual(["Class Counts>Storefront", "Product Classes>Class List"]);
  });

  it("several views over several screens in a hand-written continuation need `shown on` on every view", () => {
    expect(() => parse(HAND2(' shown on "Class List"', ""))).toThrow(/needs `shown on "Screen"`/);
  });

  it("a single-ui hand-written continuation is unchanged (no `shown on` needed)", () => {
    const c = compile(HAND);
    expect(errors(HAND)).toEqual([]);
    expect(c.model.slices.at(-1)!.elements.filter((e) => e.kind === "ui")).toHaveLength(1);
  });

  it("more than two stacked views collapse to \"<n> views after <Event>\"", () => {
    const ast = parse(`slice {\n  view A again from "E1"\n  view B again from "E1"\n  view C again from "E2"\n}`);
    expect(ast.slices[0].name).toBe("3 views after E1, E2");
  });

  it("a line without `shown on` defaults to the host ui even when another line names a screen", () => {
    const src = SCREENS("Shopper", 'view Class Counts again from "Class Renamed"');
    expect(uiEdges(src)).toEqual(["Class Counts>Rename Form", "Product Classes>Class List"]);
  });

  it("`shown on` naming a screen declared nowhere is a parse error", () => {
    expect(() => parse(SCREENS("Admin", 'view Class Counts again from "Class Renamed" shown on "Nowhere"'))).toThrow(/declared nowhere/);
  });

  it("a reaction host with no ui requires `shown on`", () => {
    const src = `context Orders
slice "A" {
  command Create Order
  event Order Created @Orders
  view Orders from "Order Created"
}
slice "Auto Ship" {
  processor Shipper from "Orders"
  command Ship Order
  event Order Shipped @Orders
  view Orders again from "Order Shipped"
}
`;
    expect(() => parse(src)).toThrow(/shown on/);
  });

  it("an event-only webhook host is unchanged (valid on 1.17.0)", () => {
    const src = `context Orders
slice "Place" {
  command Place Order
  event Order Paid @Orders
  view Board from "Order Paid"
  ui Board Page
}
slice "Webhook" {
  event Order Refunded @Orders
  view Board again from "Order Refunded"
  ui Board Page
}
`;
    const { model } = compile(src);
    expect(model.slices.map((s) => s.name)).toEqual(["Place", "Webhook"]);
  });

  it("a processor-only host keeps its shape (not lifted)", () => {
    const { model } = compile(`context Orders
slice "A" {
  command Create Order
  event Order Created @Orders
  view Todo from "Order Created"
  ui Todo Screen
}
slice "B" {
  command Ship Order
  event Order Shipped @Orders
}
slice "C" {
  processor Notify On Shipped from "Order Shipped"
  view Todo again from "Order Shipped"
  ui Todo Screen
}
`);
    expect(model.slices).toHaveLength(3);
  });

  it("no slice key contains '/'", () => {
    for (const src of [SUGAR, HAND]) expect(compile(src).refs.sliceKeys.every((k) => !k.includes("/"))).toBe(true);
  });

  it("refs: a public view in a synthesized slice keeps a single-slash element ref", () => {
    const c = compile(SUGAR.replace('view Class Counts again from "Class Renamed" shown on "Class List"', 'view Class Counts public again from "Class Renamed" shown on "Class List"'));
    const el = c.model.slices[4].elements.find((e) => e.kind === "view" && e.name === "Class Counts")!;
    const ref = c.refs.refById.get(el.id)!;
    expect(ref).toBe("rename-class--again/view.class-counts");
    expect(ref.split("/")).toHaveLength(2);
  });

  it("two unnamed continuations for the same view + event are an error", () => {
    expect(() =>
      parse(`slice {\n  view Orders again from "Order Paid"\n}\nslice {\n  view Orders again from "Order Paid"\n}`),
    ).toThrow(/two unnamed continuations for `Orders` after `Order Paid` — name one/);
  });

  it("`shown on` in a hand-written continuation must name one of its own screens", () => {
    expect(() => parse(`slice {\n  view Orders again from "Order Placed" shown on "Screen"\n}`)).toThrow(/names no `ui` of this continuation slice/);
  });
});

describe("with alternative events (GH #278 x GH #287)", () => {
  const src = `model "Alt"
context Catalog
persona Admin
slice "Create" {
  command Create Class
  event Class Created @Catalog
}
slice "Classes" {
  view Product Classes from "Class Created"
  ui Class List @Admin
}
slice "Counts" {
  view Class Counts from "Class Created"
  ui Storefront @Admin
}
slice "Rename" {
  ui Rename Form @Admin
  command Rename Class
  event Class Renamed | Class Archived @Catalog
  view Product Classes again from "Class Renamed" shown on "Class List"
  view Class Counts again from "Class Archived" shown on "Storefront"
}
`;

  it("a continuation's from may name either alternative; stacked views and the alternatives cell coexist", () => {
    const c = compile(src);
    expect(errors(src)).toEqual([]);
    expect(c.grid.collisions).toEqual([]);
    const rename = c.model.slices.findIndex((s) => s.name === "Rename");
    const cont = rename + 1;
    // the two alternatives share ONE event-lane cell in the command's column ...
    const evCells = c.grid.cells.map((row) => row[rename]).filter((e) => e?.kind === "event");
    expect(evCells).toHaveLength(1);
    // ... while the continuation column stacks two views in the api lane and two screens in the ui lane
    expect(c.grid.cells.map((row) => row[cont]).filter((e) => e?.kind === "view")).toHaveLength(2);
    expect(c.grid.cells.map((row) => row[cont]).filter((e) => e?.kind === "ui")).toHaveLength(2);
    const sources = c.model.slices[cont].elements.filter((e) => e.kind === "view").map((e) => e.from![0]);
    expect(sources).toEqual(["Class Renamed", "Class Archived"]);
  });
});
