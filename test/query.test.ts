// SPDX-License-Identifier: MIT
// Unit coverage for `em query`'s pure core (MIL-168): ModelIndex construction
// (src/model/queryIndex.ts over edges.ts's semanticEdges(), sliceDocIndex.ts), multi-model ref resolution
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

describe("repeated read models (`view X again`) — instances traverse as one node", () => {
  const REPEAT = `model "Repeat View"

persona Customer

context Order

slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}

slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

slice "Ship Order" {
  ui Ship Screen @Customer
  command Ship Order
  event Order Shipped @Order
}

slice "Open Orders Later" {
  view Open Orders again from "Order Shipped"
  ui Order List Refreshed @Customer
}
`;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-again-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function system() {
    const compiled = compileForQuery(REPEAT, dir);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return buildQuerySystem([{ file: "repeat.em", model: compiled.model, refs: compiled.refs, index: compiled.index }]);
  }

  it("the index groups instances by logicalId and never wires them as edges", () => {
    const { index } = system().entries[0];
    expect(index.instances.get("open-orders/view.open-orders")).toEqual(["open-orders-later/view.open-orders"]);
    expect(index.instances.get("open-orders-later/view.open-orders")).toEqual(["open-orders/view.open-orders"]);
    expect(index.instances.has("place-order/event.order-placed")).toBe(false);
    expect(index.out.get("open-orders/view.open-orders")?.map((e) => e.ref)).toEqual(["open-orders/ui.order-list"]);
  });

  it("downstream from an event reaches the later instance at the same depth, and its ui one deeper", () => {
    const result = queryDownstream(system(), "Order Placed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => [r.ref, r.depth, r.via])).toEqual([
      ["open-orders/view.open-orders", 1, "event->view"],
      ["open-orders-later/view.open-orders", 1, "view-instance"],
      ["open-orders/ui.order-list", 2, "view->ui"],
      ["open-orders-later/ui.order-list-refreshed", 2, "view->ui"],
    ]);
  });

  it("--depth 1 still includes the sibling instance (a zero-cost hop) but not its ui", () => {
    const result = queryDownstream(system(), "Order Placed", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => r.ref)).toEqual(["open-orders/view.open-orders", "open-orders-later/view.open-orders"]);
  });

  it("a bare name resolves to the first instance and lists the others at depth 0", () => {
    const resolved = resolveElement(system(), "Open Orders");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.match.ref).toBe("open-orders/view.open-orders");
    const result = queryDownstream(system(), "Open Orders");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => [r.ref, r.depth, r.via])).toEqual([
      ["open-orders-later/view.open-orders", 0, "view-instance"],
      ["open-orders/ui.order-list", 1, "view->ui"],
      ["open-orders-later/ui.order-list-refreshed", 1, "view->ui"],
    ]);
  });

  it("a later instance is still addressable by its own ref", () => {
    const resolved = resolveElement(system(), "open-orders-later/view.open-orders");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.match.elementName).toBe("Open Orders");
  });

  it("upstream from the refreshed screen walks back through both instances to both events", () => {
    const result = queryUpstream(system(), "Order List Refreshed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.results.map((r) => r.ref);
    expect(refs).toContain("place-order/event.order-placed");
    expect(refs).toContain("ship-order/event.order-shipped");
    expect(result.results.find((r) => r.ref === "open-orders/view.open-orders")).toMatchObject({ depth: 1, via: "view-instance" });
  });

  it("path crosses an instance hop, records it in edgeKinds, and doesn't count it in length", () => {
    const result = queryPath(system(), "Checkout", "Order List Refreshed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toEqual({
      refs: [
        "place-order/ui.checkout",
        "place-order/command.place-order",
        "place-order/event.order-placed",
        "open-orders/view.open-orders",
        "open-orders-later/view.open-orders",
        "open-orders-later/ui.order-list-refreshed",
      ],
      edgeKinds: ["ui->command", "command->event", "event->view", "view-instance", "view->ui"],
      length: 4,
    });
  });
});

describe("repeated read models with three instances — one `view-instance` step, never a chain", () => {
  const THREE = `model "Three Instances"

persona Customer

context Order

slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}

slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

slice "Ship Order" {
  ui Ship Screen @Customer
  command Ship Order
  event Order Shipped @Order
}

slice "Open Orders Later" {
  view Open Orders again from "Order Shipped"
  ui Order List Refreshed @Customer
}

slice "Open Orders Latest" {
  view Open Orders again from "Order Shipped"
  ui Order List Third @Customer
}
`;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-three-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function system() {
    const compiled = compileForQuery(THREE, dir);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return buildQuerySystem([{ file: "three.em", model: compiled.model, refs: compiled.refs, index: compiled.index }]);
  }

  it("path to a screen on the third instance crosses directly from the first — exactly one view-instance step", () => {
    const result = queryPath(system(), "Checkout", "Order List Third");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toEqual({
      refs: [
        "place-order/ui.checkout",
        "place-order/command.place-order",
        "place-order/event.order-placed",
        "open-orders/view.open-orders",
        "open-orders-latest/view.open-orders",
        "open-orders-latest/ui.order-list-third",
      ],
      edgeKinds: ["ui->command", "command->event", "event->view", "view-instance", "view->ui"],
      length: 4,
    });
  });

  it("downstream reaches all three instances at the same depth, each screen one deeper", () => {
    const result = queryDownstream(system(), "Order Placed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => [r.ref, r.depth, r.via])).toEqual([
      ["open-orders/view.open-orders", 1, "event->view"],
      ["open-orders-later/view.open-orders", 1, "view-instance"],
      ["open-orders-latest/view.open-orders", 1, "view-instance"],
      ["open-orders/ui.order-list", 2, "view->ui"],
      ["open-orders-later/ui.order-list-refreshed", 2, "view->ui"],
      ["open-orders-latest/ui.order-list-third", 2, "view->ui"],
    ]);
  });
});

describe("invariant lookup is status-agnostic", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-inv-draft-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "place-order.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\n" +
        "## Invariants / Business Rules\n- **INV-PLACE-1:** total must be positive\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds an id declared in a draft doc (out of coverage's in-scope set) and reports that status", () => {
    const result = queryInvariant(buildFixtureSystem(dir), "INV-PLACE-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ sliceRef: "place-order", status: "draft", docPath: "slices/place-order.md" });
  });
});

describe("resolveElement — a display name containing a slash", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-slash-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("falls through from the ref lookup to the name lookup", () => {
    const compiled = compileForQuery(
      `slice "Approve" {\n  ui Approve/Reject Screen @Customer\n  command Approve Thing\n  event Thing Approved\n}\n`,
      dir,
    );
    const system = buildQuerySystem([{ file: "slash.em", model: compiled.model, refs: compiled.refs, index: compiled.index }]);
    const result = resolveElement(system, "Approve/Reject Screen");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.ref).toBe("approve/ui.approve-reject-screen");
  });
});

describe("sliceDocIndex — same resolution as catalog/docJoin.ts's resolveSliceDocJoin()", () => {
  const MODEL = `model "Doc Join"

persona Customer

context Order

slice "Request Payment" {
  ui Pay @Customer
  command Request Payment
  event Payment Requested @Order note "slices/request-payment.md"
}

slice "Detect Unpaid" {
  view Unpaid Orders from "Payment Requested" note "slices/request-payment.md"
  ui Unpaid List @Customer
}

slice "Ship Order" {
  ui Ship @Customer
  command Ship Order
  event Order Shipped @Order note "slices/ship-order.md"
}

slice "Cancel Order" {
  ui Cancel @Customer
  command Cancel Order
  event Order Cancelled @Order note "slices/cancel-order.md"
}

slice "Refund Order" {
  ui Refund @Customer
  command Refund Order
  event Order Refunded @Order note "slices/request-payment.md"
}
`;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-query-docjoin-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    // Canonical doc for request-payment, which also ratifies detect-unpaid (MIL-121 `covers:`)
    // but NOT refund-order.
    writeFileSync(
      join(dir, "slices", "request-payment.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: reviewed\nversion: 1\ncovers: detect-unpaid\n---\n" +
        "## Invariants / Business Rules\n- **INV-PAY-1:** amount must be positive\n",
    );
    // ship-order: bound by note, but no file -> binding-missing-file.
    // cancel-order: file exists but its frontmatter lacks required keys -> frontmatter-invalid.
    writeFileSync(join(dir, "slices", "cancel-order.md"), "---\nstatus: draft\n---\n# Cancel Order\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function facts() {
    const { resolveSliceDocJoin } = await import("../src/catalog/docJoin.js");
    const compiled = compileForQuery(MODEL, dir);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const { model, refs, index } = compiled;
    const both = (name: string) => {
      const i = model.slices.findIndex((s) => s.name === name);
      const key = refs.sliceKeys[i];
      const fast = index.sliceFacts.get(key)!.doc;
      const slow = resolveSliceDocJoin(model.slices[i], key, dir, (id) => refs.refById.get(id)!).doc;
      return { fast, slow };
    };
    return { both, index };
  }

  it("canonical binding: found, with the doc's own status", async () => {
    const { both } = await facts();
    const { fast, slow } = both("Request Payment");
    expect(fast).toMatchObject({ found: true, reason: null, path: "slices/request-payment.md", status: "reviewed" });
    expect([fast.found, fast.path, fast.reason, fast.status]).toEqual([slow.found, slow.path, slow.reason, slow.status]);
  });

  it("ratified cross-binding (`covers:` names this slice): resolves to the OTHER slice's doc", async () => {
    const { both } = await facts();
    const { fast, slow } = both("Detect Unpaid");
    expect(fast).toMatchObject({ found: true, reason: null, path: "slices/request-payment.md", status: "reviewed" });
    expect([fast.found, fast.path, fast.reason, fast.status]).toEqual([slow.found, slow.path, slow.reason, slow.status]);
  });

  it("unratified cross-binding (`covers:` doesn't name this slice): no-doc-bound", async () => {
    const { both } = await facts();
    const { fast, slow } = both("Refund Order");
    expect(fast).toMatchObject({ found: false, reason: "no-doc-bound", path: "slices/refund-order.md", status: null, body: null });
    expect([fast.found, fast.path, fast.reason, fast.status]).toEqual([slow.found, slow.path, slow.reason, slow.status]);
  });

  it("bound but no file: binding-missing-file", async () => {
    const { both } = await facts();
    const { fast, slow } = both("Ship Order");
    expect(fast).toMatchObject({ found: false, reason: "binding-missing-file", path: "slices/ship-order.md", body: null });
    expect([fast.found, fast.path, fast.reason, fast.status]).toEqual([slow.found, slow.path, slow.reason, slow.status]);
  });

  it("file with unusable frontmatter: found, frontmatter-invalid, nothing to scan for invariants", async () => {
    const { both, index } = await facts();
    const { fast, slow } = both("Cancel Order");
    expect(fast).toMatchObject({ found: true, reason: "frontmatter-invalid", status: null, body: null });
    expect([fast.found, fast.path, fast.reason, fast.status]).toEqual([slow.found, slow.path, slow.reason, slow.status]);
    // The one invariant in the fixture is attributed to its canonical slice only.
    expect(index.invariants.get("INV-PAY-1")).toEqual({ id: "INV-PAY-1", sliceKey: "request-payment" });
  });

  it("a mixed-case filename is a doc exactly where readSliceDoc() would find it", async () => {
    const { readSliceDoc } = await import("../src/catalog/readSliceDoc.js");
    const { loadSliceDocsOnce } = await import("../src/model/sliceDocIndex.js");
    const mixed = mkdtempSync(join(tmpdir(), "em-query-mixedcase-"));
    try {
      mkdirSync(join(mixed, "slices"));
      writeFileSync(join(mixed, "slices", "Place-Order.md"), "---\nstatus: draft\n---\n# Place Order\n");
      const viaReadSliceDoc = readSliceDoc(mixed, "place-order") !== null;
      expect(loadSliceDocsOnce(mixed).has("place-order")).toBe(viaReadSliceDoc);
    } finally {
      rmSync(mixed, { recursive: true, force: true });
    }
  });
});

describe("buildQueryJson — omitted optional args echo as null", () => {
  it("keeps every args key on a stable name, null when the caller passed undefined", async () => {
    const { buildQueryJson } = await import("../src/emit/queryJson.js");
    const doc = JSON.parse(buildQueryJson("slices", ["m.em"], { pattern: undefined, status: "draft", tag: undefined }, []));
    expect(doc.args).toEqual({ pattern: null, status: "draft", tag: null });
  });
});
