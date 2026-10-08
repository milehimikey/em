// SPDX-License-Identifier: MIT
// Coverage for the slice doc's generated regions (src/catalog/sliceSections.ts, MIL-266): the
// region bodies built from the model, the marker scanner, the structural-problem finder behind
// `slice-doc/structured-section-malformed`, and the template ↔ `em slice new` skeleton agreement.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import {
  buildSliceRegions,
  findStructuredSectionProblems,
  placeholderRegions,
  scanSliceRegions,
} from "../src/catalog/sliceSections.js";
import { buildSliceDocContent } from "../src/cli/sliceNew.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(join(ROOT, ".claude/skills/event-modeling-shared/templates/slice.md"), "utf8");

const MODEL = [
  "context Order",
  'slice "Place" {',
  "  ui Basket",
  "  command Place Order {",
  "    total: decimal",
  "    note?: text renamed from \"comment\"",
  "  }",
  '  invariant INV-PLC-1 "Total must be positive"',
  "  event Order Placed @Order {",
  "    orderId: uuid assigned",
  "    total: decimal",
  "    channel: string",
  "  }",
  "  invariant INV-PLC-2",
  "  event Order Logged @Order",
  "}",
  'slice "Show" {',
  '  view Orders from "Order Placed" {',
  "    total: decimal",
  "    status: string derived",
  "    region: string",
  "  }",
  "  ui Orders Screen",
  "}",
].join("\n");

function regionsOf(sliceIndex: number) {
  const { model } = compile(MODEL);
  return buildSliceRegions(model, [sliceIndex]);
}

describe("buildSliceRegions", () => {
  it("fills command/event tables, suffixes several events, notes an empty kind, and lists invariants", () => {
    expect(regionsOf(0)).toEqual([
      {
        name: "em-slice-command",
        kind: "command",
        body: [
          "**Command:** `Place Order`",
          "",
          "| Field | Type | Required | Rules / Validation |",
          "|-------|------|----------|--------------------|",
          "| total | decimal | yes | — |",
          '| note | text | no | renamed from "comment" |',
        ],
      },
      {
        name: "em-slice-event-order-placed",
        kind: "event",
        body: [
          "**Event:** `Order Placed` → context `Order`",
          "",
          "| Field | Type | Immutable Fact? | Source / Notes |",
          "|-------|------|-----------------|----------------|",
          "| orderId | uuid | yes | assigned (set by the handler) |",
          "| total | decimal | yes | from command `Place Order` |",
          "| channel | string | yes | {{ }} |",
        ],
      },
      {
        name: "em-slice-event-order-logged",
        kind: "event",
        body: ["**Event:** `Order Logged` → context `Order`", "", "_No fields declared in the model._"],
      },
      { name: "em-slice-view", kind: "view", body: ["_This slice has no read model in the model._"] },
      {
        name: "em-slice-invariants",
        kind: "invariants",
        body: ["- **INV-PLC-1** — Total must be positive", "- **INV-PLC-2**"],
      },
    ]);
  });

  it("fills a view table with its source event and the `derived` marker", () => {
    const regions = regionsOf(1);
    expect(regions[2]).toEqual({
      name: "em-slice-view",
      kind: "view",
      body: [
        '- **View:** `Orders` built from events: "Order Placed"',
        "",
        "| Field | Type | Source / Notes |",
        "|-------|------|----------------|",
        "| total | decimal | from event `Order Placed` |",
        "| status | string | Derived |",
        "| region | string | {{ }} |",
      ],
    });
    expect(regions[0].body).toEqual(["_This slice has no command in the model._"]);
    expect(regions[3].body).toEqual(["_No invariants declared in the model._"]);
  });

  it("never writes the `**INV-X:**` declaring label (invariants/declared-in-both)", () => {
    for (const r of regionsOf(0)) for (const line of r.body) expect(line).not.toMatch(/\*\*INV-[A-Z0-9-]+:\*\*/);
  });
});

describe("scanSliceRegions / findStructuredSectionProblems", () => {
  const ok = [
    "<!-- GENERATED:em-slice-command:start — note -->",
    "**Command:** `X`",
    "<!-- GENERATED:em-slice-command:end -->",
  ].join("\n");

  it("returns each region's body between the marker lines", () => {
    const scan = scanSliceRegions(`a\n${ok}\nb\n`);
    expect(scan.problems).toEqual([]);
    expect(scan.regions.map((r) => [r.name, r.body])).toEqual([["em-slice-command", "**Command:** `X`"]]);
  });

  it("reports unbalanced, nested, duplicated and unknown markers with exact messages", () => {
    expect(scanSliceRegions("<!-- GENERATED:em-slice-command:start -->\nx\n").problems).toEqual([
      'region "em-slice-command" has no end marker',
    ]);
    expect(scanSliceRegions("<!-- GENERATED:em-slice-event:end -->\n").problems).toEqual([
      'end marker for region "em-slice-event" has no start marker',
    ]);
    expect(
      scanSliceRegions(
        "<!-- GENERATED:em-slice-command:start -->\n<!-- GENERATED:em-slice-event:start -->\n<!-- GENERATED:em-slice-event:end -->\n",
      ).problems,
    ).toEqual(['region "em-slice-event" starts inside region "em-slice-command" (no end marker for "em-slice-command" before it)']);
    expect(scanSliceRegions(`${ok}\n${ok}\n`).problems).toEqual(['region "em-slice-command" appears more than once']);
    expect(scanSliceRegions("<!-- GENERATED:em-slice-notes:start -->\n<!-- GENERATED:em-slice-notes:end -->\n").problems).toEqual([
      'region "em-slice-notes" is not a known generated region (em-slice-command|event|view[-<slug>], em-slice-invariants)',
    ]);
  });

  it("flags a generated table whose header row differs from the template's", () => {
    const doc = [
      "<!-- GENERATED:em-slice-command:start -->",
      "**Command:** `X`",
      "",
      "| Field | Type | Rules |",
      "|---|---|---|",
      "| a | b | c |",
      "<!-- GENERATED:em-slice-command:end -->",
    ].join("\n");
    expect(findStructuredSectionProblems(doc)).toEqual([
      'region "em-slice-command"\'s table header is "| Field | Type | Rules |" — expected "| Field | Type | Required | Rules / Validation |"',
    ]);
  });

  it("finds nothing in a 1.13-style free-prose doc (no markers, no `### Scenario:`)", () => {
    const doc = [
      "## Command / Input",
      "**Command:** `X`",
      "",
      "| Field | Type | Rules |",
      "|---|---|---|",
      "## Scenarios (Given / When / Then)",
      "- **Happy path**",
      "  - **Given:** a",
    ].join("\n");
    expect(findStructuredSectionProblems(doc)).toEqual([]);
  });
});

describe("template ↔ em slice new skeleton", () => {
  const skeleton = buildSliceDocContent("Name", "name", "state-change", "A → B");
  const headings = (text: string) => text.split("\n").filter((l) => /^#{2,3} /.test(l));

  it("emits every template section heading in template order (Delta excepted — v1 has none)", () => {
    const fromTemplate = headings(TEMPLATE.slice(TEMPLATE.indexOf("\n---\n# Slice:"))).filter(
      (h) => !/^## Delta|^### (Added|Modified|Removed|Renamed)/.test(h),
    );
    expect(headings(skeleton)).toEqual(fromTemplate);
  });

  it("the template's regions are exactly the placeholder regions, and both docs scan clean", () => {
    const scan = scanSliceRegions(TEMPLATE);
    expect(scan.problems).toEqual([]);
    expect(scan.regions.map((r) => ({ name: r.name, body: r.body.split("\n") }))).toEqual(
      placeholderRegions().map((r) => ({ name: r.name, body: r.body })),
    );
    expect(findStructuredSectionProblems(TEMPLATE)).toEqual([]);
    expect(findStructuredSectionProblems(skeleton)).toEqual([]);
    expect(scanSliceRegions(skeleton).regions.map((r) => r.body)).toEqual(scan.regions.map((r) => r.body));
  });
});
