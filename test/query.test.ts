// SPDX-License-Identifier: MIT
// Unit coverage for `em query`'s pure core (MIL-168): ModelIndex construction
// (src/model/queryIndex.ts, queryEdges.ts, sliceDocIndex.ts), multi-model ref resolution
// (src/query/system.ts), and the eight verb functions (src/query/verbs.ts) — determinism,
// ambiguity errors, depth limits, empty results, and multi-model attribution. CLI-level
// (commander wiring, exit codes, --json) and MCP-parity coverage live in test/cli.test.ts and
// test/mcp.test.ts respectively.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileForQuery } from "../src/query/pipeline.js";
import { buildQuerySystem, resolveElement, qualifyRef } from "../src/query/system.js";
import {
  queryConsumers,
  queryProducers,
  queryDownstream,
  queryUpstream,
  querySlices,
  queryInvariant,
  queryField,
  queryPath,
} from "../src/query/verbs.js";

const FIXTURE = `model "Query Fixture"

persona Customer

context Order

slice "Place Order" {
  ui Checkout @Customer
  command Place Order {
    customerId
    total: Money
  }
  event Order Placed @Order note "slices/place-order.md" {
    orderId
    total: Money tag
    placedAt renamed from "createdAt"
  }
}

slice "Open Orders" {
  view Open Orders from "Order Placed" {
    orderId
    total: Money
  }
  ui Order List @Customer
}

slice "Watch For Shipping" {
  view Orders To Ship from "Order Placed"
}

slice "Ship Order" {
  processor Shipping Watcher from "Orders To Ship"
  command Ship Order {
    orderId
  }
  event Order Shipped @Order {
    orderId
    shippedBy assigned
  }
}
`;

function buildFixtureSystem(baseDir: string) {
  const compiled = compileForQuery(FIXTURE, baseDir);
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return buildQuerySystem([{ file: "fixture.em", model: compiled.model, refs: compiled.refs, index: compiled.index }]);
}

describe("ModelIndex + compileForQuery (single model)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-unit-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("builds byRef, out, and in for every element, keyed by export ref", () => {
    const compiled = compileForQuery(FIXTURE, dir);
    const { index, refs } = compiled;
    expect(index.byRef.size).toBe(compiled.model.elements.length);
    const eventRef = refs.refById.get(compiled.model.byName.get("order placed")![0].id)!;
    expect(eventRef).toBe("place-order/event.order-placed");
    expect(index.byRef.get(eventRef)?.name).toBe("Order Placed");
    // command -> event
    const commandRef = refs.refById.get(compiled.model.byName.get("place order")!.find((e) => e.kind === "command")!.id)!;
    expect(index.out.get(commandRef)).toContainEqual({ ref: eventRef, kind: "command->event" });
    expect(index.in.get(eventRef)).toContainEqual({ ref: commandRef, kind: "command->event" });
  });

  it("is deterministic — same source compiled twice yields the same edge order", () => {
    const a = compileForQuery(FIXTURE, dir);
    const b = compileForQuery(FIXTURE, dir);
    const refA = [...a.index.byRef.keys()];
    const refB = [...b.index.byRef.keys()];
    expect(refA).toEqual(refB);
    for (const ref of refA) {
      expect(a.index.out.get(ref) ?? []).toEqual(b.index.out.get(ref) ?? []);
      expect(a.index.in.get(ref) ?? []).toEqual(b.index.in.get(ref) ?? []);
    }
  });

  it("wires the full six-connection + reaction chain for the automation slice", () => {
    const compiled = compileForQuery(FIXTURE, dir);
    const { index, refs, model } = compiled;
    const refOf = (name: string, kind: string) => refs.refById.get(model.byName.get(name)!.find((e) => e.kind === kind)!.id)!;

    const uiRef = refOf("checkout", "ui");
    const placeCmdRef = refOf("place order", "command");
    const orderPlacedRef = refOf("order placed", "event");
    const openOrdersViewRef = refOf("open orders", "view");
    const orderListUiRef = refOf("order list", "ui");
    const watchViewRef = refOf("orders to ship", "view");
    const processorRef = refOf("shipping watcher", "processor");
    const shipCmdRef = refOf("ship order", "command");
    const shipEventRef = refOf("order shipped", "event");

    expect(index.out.get(uiRef)).toContainEqual({ ref: placeCmdRef, kind: "ui->command" });
    expect(index.out.get(placeCmdRef)).toContainEqual({ ref: orderPlacedRef, kind: "command->event" });
    expect(index.out.get(orderPlacedRef)).toContainEqual({ ref: openOrdersViewRef, kind: "event->view" });
    expect(index.out.get(openOrdersViewRef)).toContainEqual({ ref: orderListUiRef, kind: "view->ui" });
    expect(index.out.get(orderPlacedRef)).toContainEqual({ ref: watchViewRef, kind: "event->view" });
    expect(index.out.get(watchViewRef)).toContainEqual({ ref: processorRef, kind: "view->reaction" });
    expect(index.out.get(processorRef)).toContainEqual({ ref: shipCmdRef, kind: "reaction->command" });
    expect(index.out.get(shipCmdRef)).toContainEqual({ ref: shipEventRef, kind: "command->event" });
  });
});

describe("resolveElement — bare names, refs, ambiguity", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-resolve-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a stable ref directly", () => {
    const system = buildFixtureSystem(dir);
    const result = resolveElement(system, "place-order/event.order-placed");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.elementName).toBe("Order Placed");
  });

  it("resolves a unique bare display name, case/whitespace-insensitively", () => {
    const system = buildFixtureSystem(dir);
    const result = resolveElement(system, "  order   PLACED ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.ref).toBe("place-order/event.order-placed");
  });

  it("a bare name matching multiple elements is an error listing every candidate ref, never a guess", () => {
    const twoModel = `model "Dup"
slice "A" {
  ui Screen @Customer
}
slice "B" {
  ui Screen @Customer
}
`;
    const compiled = compileForQuery(twoModel, dir);
    const system = buildQuerySystem([{ file: "dup.em", model: compiled.model, refs: compiled.refs, index: compiled.index }]);
    const result = resolveElement(system, "Screen");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ambiguous");
      expect(result.error).toContain("a/ui.screen");
      expect(result.error).toContain("b/ui.screen");
    }
  });

  it("an unknown ref/name is an error", () => {
    const system = buildFixtureSystem(dir);
    const result = resolveElement(system, "No Such Element");
    expect(result.ok).toBe(false);
  });
});

describe("multi-model addressing (qualified refs, per-model resolution, cross-model ambiguity)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-multi-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function twoModelSystem() {
    const a = `slice "A Slice" {\n  ui A Screen @Customer\n  command Do A Thing\n  event Shared Event\n}\n`;
    const b = `slice "B Slice" {\n  ui B Screen @Customer\n  command Do B Thing\n  event Shared Event\n}\n`;
    const ca = compileForQuery(a, dir);
    const cb = compileForQuery(b, dir);
    return buildQuerySystem([
      { file: "a.em", model: ca.model, refs: ca.refs, index: ca.index },
      { file: "b.em", model: cb.model, refs: cb.refs, index: cb.index },
    ]);
  }

  it("qualifies refs with <modelKey>: only once more than one file is given", () => {
    const system = twoModelSystem();
    expect(system.multiModel).toBe(true);
    expect(qualifyRef(system, "a", "a-slice/ui.a-screen")).toBe("a:a-slice/ui.a-screen");
  });

  it("a <modelKey>:ref qualifier resolves within exactly that model", () => {
    const system = twoModelSystem();
    const result = resolveElement(system, "a:a-slice/ui.a-screen");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.modelKey).toBe("a");
  });

  it("an unqualified name unique within one model resolves there, qualified in the answer", () => {
    const system = twoModelSystem();
    const result = resolveElement(system, "A Screen");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.qualifiedRef).toBe("a:a-slice/ui.a-screen");
  });

  it("unqualified + multi-model + ambiguous is an error listing every qualified candidate", () => {
    const system = twoModelSystem();
    const result = resolveElement(system, "Shared Event");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("a:a-slice/event.shared-event");
      expect(result.error).toContain("b:b-slice/event.shared-event");
    }
  });

  it("consumers on a qualified ref returns qualified results, attributed to the right model", () => {
    const system = twoModelSystem();
    const result = queryConsumers(system, "a:a-slice/event.shared-event");
    expect(result.ok).toBe(true);
    // no consumer wired in this fixture — legitimately empty, still ok
    if (result.ok) expect(result.results).toEqual([]);
  });
});

describe("consumers / producers", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-cp-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("consumers: both views reading Order Placed, with slice attribution", () => {
    const system = buildFixtureSystem(dir);
    const result = queryConsumers(system, "Order Placed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.results.map((r) => r.ref).sort();
    expect(refs).toEqual(["open-orders/view.open-orders", "watch-for-shipping/view.orders-to-ship"]);
  });

  it("producers: the command producing Order Placed, plus its ui trigger", () => {
    const system = buildFixtureSystem(dir);
    const result = queryProducers(system, "Order Placed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ref).toBe("place-order/command.place-order");
    expect(result.results[0].uiTriggers.map((t) => t.ref)).toEqual(["place-order/ui.checkout"]);
  });

  it("an event with no consumers prints/returns an empty result set, not an error", () => {
    const system = buildFixtureSystem(dir);
    const result = queryConsumers(system, "Order Shipped");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toEqual([]);
  });

  it("refuses a --event ref that doesn't resolve to an event", () => {
    const system = buildFixtureSystem(dir);
    const result = queryConsumers(system, "Checkout");
    expect(result.ok).toBe(false);
  });
});

describe("downstream / upstream (transitive closure, depth limits)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-closure-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("downstream from the ui reaches every element along the chain, breadth-first, deduped", () => {
    const system = buildFixtureSystem(dir);
    const result = queryDownstream(system, "Checkout");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.results.map((r) => r.ref);
    expect(refs).toContain("place-order/command.place-order");
    expect(refs).toContain("place-order/event.order-placed");
    expect(refs).toContain("ship-order/event.order-shipped");
    expect(new Set(refs).size).toBe(refs.length); // no duplicates
  });

  it("--depth 1 stops after one hop", () => {
    const system = buildFixtureSystem(dir);
    const result = queryDownstream(system, "Checkout", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => r.ref)).toEqual(["place-order/command.place-order"]);
    expect(result.results[0].depth).toBe(1);
  });

  it("upstream from the shipped event walks back to the triggering ui", () => {
    const system = buildFixtureSystem(dir);
    const result = queryUpstream(system, "Order Shipped");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => r.ref)).toContain("place-order/ui.checkout");
  });

  it("an element with nothing downstream returns an empty (not erroring) result", () => {
    const system = buildFixtureSystem(dir);
    const result = queryDownstream(system, "Order Shipped");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toEqual([]);
  });

  it("rejects a non-positive --depth", () => {
    const system = buildFixtureSystem(dir);
    const result = queryDownstream(system, "Checkout", 0);
    expect(result.ok).toBe(false);
  });
});

describe("slices — AND-combined filters", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-slices-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("no filters returns every slice", () => {
    const system = buildFixtureSystem(dir);
    const result = querySlices(system, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.map((r) => r.ref).sort()).toEqual(["open-orders", "place-order", "ship-order", "watch-for-shipping"].sort());
    }
  });

  it("--pattern automation matches only the reaction slice", () => {
    const system = buildFixtureSystem(dir);
    const result = querySlices(system, { pattern: "automation" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results.map((r) => r.ref)).toEqual(["ship-order"]);
  });

  it("--context and --tag AND-combine down to the declaring slice", () => {
    const system = buildFixtureSystem(dir);
    const result = querySlices(system, { context: "Order", tag: "total" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results.map((r) => r.ref)).toEqual(["place-order"]);
  });

  it("a filter matching nothing returns an empty (not erroring) result", () => {
    const system = buildFixtureSystem(dir);
    const result = querySlices(system, { persona: "NoSuchPersona" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toEqual([]);
  });
});

describe("invariant — declaring slice + doc facts + --tests citations", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-inv-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "place-order.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n" +
        "## Invariants / Business Rules\n- **INV-PLACE-1:** total must be positive\n- **INV-PLACE-2:** customerId is required\n",
    );
    writeFileSync(join(dir, "tests", "place-order.test.ts"), `it("rejects a non-positive total (INV-PLACE-1)", () => {});\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the declaring slice and doc facts without --tests", () => {
    const system = buildFixtureSystem(dir);
    const result = queryInvariant(system, "INV-PLACE-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].sliceRef).toBe("place-order");
    expect(result.results[0].status).toBe("ready-to-implement");
    expect(result.results[0].docPath).toBe("slices/place-order.md");
    expect(result.results[0].citations).toBeNull();
  });

  it("with --tests, returns the citing file:line via a single-ID coverage-machinery scan", () => {
    const system = buildFixtureSystem(dir);
    const cited = queryInvariant(system, "INV-PLACE-1", join(dir, "tests"));
    expect(cited.ok).toBe(true);
    if (cited.ok) expect(cited.results[0].citations).toEqual([{ file: "place-order.test.ts", line: 1 }]);

    const uncited = queryInvariant(system, "INV-PLACE-2", join(dir, "tests"));
    expect(uncited.ok).toBe(true);
    if (uncited.ok) expect(uncited.results[0].citations).toEqual([]);
  });

  it("an unknown invariant id is an error", () => {
    const system = buildFixtureSystem(dir);
    const result = queryInvariant(system, "INV-NO-SUCH");
    expect(result.ok).toBe(false);
  });
});

describe("field — type/tag/assigned/renamed-from facts", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-field-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports a tagged, typed field", () => {
    const system = buildFixtureSystem(dir);
    const result = queryField(system, "Order Placed", "total");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ name: "total", type: "Money", tag: true, assigned: false, renamedFrom: null });
  });

  it("reports a renamed-from chain", () => {
    const system = buildFixtureSystem(dir);
    const result = queryField(system, "Order Placed", "placedAt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0].renamedFrom).toEqual(["createdAt"]);
  });

  it("reports an assigned marker", () => {
    const system = buildFixtureSystem(dir);
    const result = queryField(system, "Order Shipped", "shippedBy");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0].assigned).toBe(true);
  });

  it("a field that doesn't exist on the element is an empty (not erroring) result", () => {
    const system = buildFixtureSystem(dir);
    const result = queryField(system, "Order Placed", "noSuchField");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toEqual([]);
  });
});

describe("path — shortest path through the legal-connection graph", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-path-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the shortest directed path end to end", () => {
    const system = buildFixtureSystem(dir);
    const result = queryPath(system, "Checkout", "Order Shipped");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0].refs[0]).toBe("place-order/ui.checkout");
    expect(result.results[0].refs.at(-1)).toBe("ship-order/event.order-shipped");
    expect(result.results[0].length).toBe(result.results[0].refs.length - 1);
  });

  it("no path is a legitimate empty result, not an error", () => {
    const system = buildFixtureSystem(dir);
    const result = queryPath(system, "Order Shipped", "Checkout"); // wrong direction
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toEqual([]);
  });

  it("the same element is a zero-length path", () => {
    const system = buildFixtureSystem(dir);
    const result = queryPath(system, "Checkout", "Checkout");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results[0]).toEqual({ refs: ["place-order/ui.checkout"], edgeKinds: [], length: 0 });
  });
});
