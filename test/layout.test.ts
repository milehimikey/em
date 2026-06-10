// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { layout } from "../src/layout/grid.js";

function build(src: string) {
  return layout(normalize(parse(src)));
}

describe("grid layout", () => {
  it("orders rows: header -> ui personas -> api -> event contexts", () => {
    const grid = build(`
persona Customer
persona Manager
context Order

slice "S" {
  ui Screen @Customer
  command Do It
  event It Happened @Order
}
`);
    expect(grid.rows.map((r) => r.key)).toEqual([
      "__header",
      "ui:Customer",
      "ui:Manager",
      "api",
      "event:Order",
    ]);
  });

  it("puts commands and read models in the single API row", () => {
    const grid = build(`
context Order
slice "Change" {
  command Do It
  event Done @Order
}
slice "Show" {
  view A View from "Done"
}
`);
    const api = grid.rowIndexByKey.get("api")!;
    expect(grid.cells[api][0]?.kind).toBe("command");
    expect(grid.cells[api][1]?.kind).toBe("view");
  });

  it("puts a header row first and adds automation just below it when used", () => {
    const withAuto = build(`
slice "S" {
  processor Gateway
  command Do It
  event Done
}
`);
    expect(withAuto.rows[0].band).toBe("header");
    expect(withAuto.rows[1].band).toBe("automation");

    const without = build(`
slice "S" {
  command Do It
  event Done
}
`);
    expect(without.rows.some((r) => r.band === "automation")).toBe(false);
  });

  it("fills empty cells with placeholders", () => {
    const grid = build(`
context Order
slice "A" {
  event One @Order
}
slice "B" {
  command Two
}
`);
    expect(grid.cols).toBe(2);
    const api = grid.rowIndexByKey.get("api")!;
    const ev = grid.rowIndexByKey.get("event:Order")!;
    expect(grid.cells[ev][0]?.name).toBe("One");
    expect(grid.cells[ev][1]).toBeNull();
    expect(grid.cells[api][1]?.name).toBe("Two");
    expect(grid.cells[api][0]).toBeNull();
  });

  it("flags a collision when two same-band elements share a slice", () => {
    const grid = build(`
slice "S" {
  command One
  command Two
}
`);
    expect(grid.collisions).toHaveLength(1);
    expect(grid.collisions[0].dropped.name).toBe("Two");
  });

  it("collapses an empty API lane but keeps it with keepEmptyLanes", () => {
    const src = `
context Order
slice "S" {
  event Done @Order
}
`;
    const collapsed = layout(normalize(parse(src)));
    expect(collapsed.rows.some((r) => r.band === "api")).toBe(false);

    const kept = layout(normalize(parse(src)), { keepEmptyLanes: true });
    expect(kept.rows.some((r) => r.band === "api")).toBe(true);
  });
});