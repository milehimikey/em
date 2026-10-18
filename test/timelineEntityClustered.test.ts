// SPDX-License-Identifier: MIT
// GH #281 — `timeline-entity-clustered`: the lifecycle-per-entity (CRUD-on-a-timeline) shape.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { validate, TIMELINE_ENTITY_CLUSTER_MIN_RUN } from "../src/model/validate.js";
import { computeRefs } from "../src/model/refs.js";
import { layout } from "../src/layout/grid.js";
import { RULES } from "../src/model/rules.js";

const hits = (src: string) => {
  const model = normalize(parse(src));
  return validate(model, layout(model), computeRefs(model)).filter((d) => d.code === "timeline-entity-clustered");
};

// Three Catalog writes in a row, then one Catalog view: the CRUD-per-entity shape.
const CLUSTERED = `
slice "Create Class" {
  ui Class Form
  command Create Class
  event Class Created @Catalog
}
slice "Rename Class" {
  ui Rename Form
  command Rename Class
  event Class Renamed @Catalog
}
slice "Retire Class" {
  ui Retire Form
  command Retire Class
  event Class Retired @Catalog
}
slice "Class List" {
  view Class List from "Class Created", "Class Renamed", "Class Retired"
  ui Class Screen
}
`;

// The same events, interleaved by the business journey with another context's write and read.
const STORYLINE = `
slice "Create Class" {
  ui Class Form
  command Create Class
  event Class Created @Catalog
}
slice "Class List" {
  view Class List from "Class Created"
  ui Class Screen
}
slice "Set Price" {
  ui Price Form
  command Set Price
  event Price Set @Pricing
}
slice "Rename Class" {
  ui Rename Form
  command Rename Class
  event Class Renamed @Catalog
}
slice "Retire Class" {
  ui Retire Form
  command Retire Class
  event Class Retired @Catalog
}
slice "Price List" {
  view Price List from "Price Set", "Class Renamed"
  ui Price Screen
}
`;

describe("timeline-entity-clustered", () => {
  it("is a registered advisory warning in the shape family", () => {
    expect(RULES["timeline-entity-clustered"].severity).toBe("warning");
    expect(RULES["timeline-entity-clustered"].family).toBe("shape");
    expect(TIMELINE_ENTITY_CLUSTER_MIN_RUN).toBe(3);
  });

  it("fires once for the CRUD shape, with refs to every slice in the run and a message naming first/last/context", () => {
    const d = hits(CLUSTERED);
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
    expect(d[0].refs).toEqual(["create-class", "rename-class", "retire-class"]);
    expect(d[0].message).toContain('"Create Class"');
    expect(d[0].message).toContain('"Retire Class"');
    expect(d[0].message).toContain('"Catalog"');
    expect(d[0].message).toContain("docs/storyline.md");
  });

  it("is clean when the same slices are ordered by the business journey", () => {
    expect(hits(STORYLINE)).toEqual([]);
  });

  it("is clean below the threshold (two same-context slices)", () => {
    const two = CLUSTERED.replace(/slice "Retire Class" \{[\s\S]*?\n\}\n/, "").replace(', "Class Retired"', "");
    expect(hits(two)).toEqual([]);
  });

  it("is clean when a view fed by another context sits inside the run", () => {
    const interleaved = CLUSTERED.replace(
      'slice "Retire Class"',
      'slice "Price Seen" {\n  command Quote\n  event Quoted @Pricing\n  view Quote View from "Quoted"\n  ui Q\n}\nslice "Retire Class"',
    );
    expect(hits(interleaved)).toEqual([]);
  });

  it("is clean when the next view reads another context", () => {
    const other = CLUSTERED.replace('from "Class Created", "Class Renamed", "Class Retired"', 'from "Class Created", "Price Set"').replace(
      'slice "Class List"',
      'slice "Price" {\n  command Set Price\n  event Price Set @Pricing\n}\nslice "Class List"',
    );
    expect(hits(other)).toEqual([]);
  });

  it("fires once per run when two runs appear in one model", () => {
    const second =
      CLUSTERED.replace(/slice "Class List"[\s\S]*$/, "") +
      `slice "Class List" {\n  view Class List from "Class Created"\n  ui Class Screen\n}\n` +
      `slice "P1" {\n  command A1\n  event E1 @Pricing\n}\nslice "P2" {\n  command A2\n  event E2 @Pricing\n}\nslice "P3" {\n  command A3\n  event E3 @Pricing\n}\n` +
      `slice "Price List" {\n  view Price List from "E1", "E2", "E3"\n  ui PL\n}\n`;
    expect(hits(second)).toHaveLength(2);
  });
});
