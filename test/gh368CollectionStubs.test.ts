// SPDX-License-Identifier: MIT
// GH #368: a collection field's scenario stubs (GH #288) are retired by `em slice sync` once the
// doc's authored `## Scenarios` covers them — by the stub's own `<field> after <Event>` title or by
// a Given naming the event with the field named in the block — and `em validate` warns on two
// authored scenarios sharing one title (`slice-doc/scenario-title-duplicate`).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { authoredScenarios, buildSliceRegions, coversCollectionStub, generatedRegionPlaceholders, scanSliceRegions } from "../src/catalog/sliceSections.js";
import { duplicateScenarioTitles } from "../src/catalog/scenarios.js";
import { syncDocText, runSliceSync } from "../src/cli/sliceSync.js";
import { buildSliceDocContent } from "../src/cli/sliceNew.js";
import { validateDocModelConsistency } from "../src/catalog/docModelConsistencyValidate.js";

const MODEL = `
model "Attrs"
context Catalog
persona Admin

type AttributeValue { valueId: string, value: string }

slice "Add Value" {
  ui Value Form @Admin
  command Add Value
  event Attribute Value Created @Catalog { attributeId: string, valueId: string, value: string }
}

slice "Remove Value" {
  ui Value List @Admin
  command Remove Value
  event Attribute Value Deleted @Catalog { attributeId: string, valueId: string }
}

slice "Attributes" {
  view Attributes note "slices/attributes.md" from "Attribute Value Created", "Attribute Value Deleted" {
    attributeId: string
    values: AttributeValue[] derived from "Attribute Value Created", "Attribute Value Deleted"
  }
  ui Attribute Screen @Admin
}
`;

const STUB_CREATED = "### Scenario: values after Attribute Value Created";
const STUB_DELETED = "### Scenario: values after Attribute Value Deleted";
const STUBS_HEADER = "Scenario stubs for `values`";

const SCENARIO_CREATED = [
  "### Scenario: values after Attribute Value Created",
  "- **Given:**",
  "  - `Attribute Value Created` for attribute A with value V",
  "- **When:**",
  "  - the view is queried",
  "- **Then:**",
  "  - `values` contains V",
].join("\n");
const SCENARIO_DELETED_OWN_TITLE = [
  "### Scenario: Removing a value drops it from the list",
  "- **Given:**",
  "  - `Attribute Value Created` then `Attribute Value Deleted` for value V",
  "- **When:**",
  "  - the view is queried",
  "- **Then:**",
  "  - `values` omits V",
].join("\n");

function freshDoc(): { model: ReturnType<typeof compile>["model"]; doc: string } {
  const { model } = compile(MODEL);
  const doc = buildSliceDocContent("Attributes", "attributes", "state-view", "Admin → Catalog", buildSliceRegions(model, [2]));
  return { model, doc };
}
/** The doc with `scenarios` appended to its `## Scenarios` section (after the template's Happy path). */
function withScenarios(doc: string, ...scenarios: string[]): string {
  const marker = "## Alternate & Error Flows";
  expect(doc).toContain(marker);
  return doc.replace(marker, scenarios.join("\n\n") + "\n\n" + marker);
}
function viewRegion(doc: string): string {
  const r = scanSliceRegions(doc).regions.find((x) => x.name === "em-slice-view")!;
  return doc.slice(r.innerStart, r.innerEnd);
}

describe("collection scenario stubs retire against authored scenarios (GH #368)", () => {
  it("a new doc carries every stub (nothing authored yet) and keeps them when no doc is given to sync", () => {
    const { model, doc } = freshDoc();
    expect(viewRegion(doc)).toContain(STUBS_HEADER);
    expect(viewRegion(doc)).toContain(STUB_CREATED);
    expect(viewRegion(doc)).toContain(STUB_DELETED);
    expect(syncDocText(doc, buildSliceRegions(model, [2])).status).toBe("ok");
  });

  it("the stubs sync itself wrote never count as covering themselves", () => {
    const { model, doc } = freshDoc();
    expect(authoredScenarios(doc).map((s) => s.title)).toEqual(["Happy path"]);
    const r = syncDocText(doc, buildSliceRegions(model, [2], { authoredDoc: doc }));
    expect(r.status).toBe("ok");
    expect(viewRegion(r.next)).toContain(STUB_CREATED);
  });

  it("writing a scenario under the stub's exact heading retires that stub and keeps the other", () => {
    const { model, doc } = freshDoc();
    const authored = withScenarios(doc, SCENARIO_CREATED);
    const r = syncDocText(authored, buildSliceRegions(model, [2], { authoredDoc: authored }));
    expect(r.status).toBe("stale");
    expect(r.regions.find((x) => x.name === "em-slice-view")!.status).toBe("stale");
    const region = viewRegion(r.next);
    expect(region).not.toContain(STUB_CREATED);
    expect(region).toContain(STUBS_HEADER);
    expect(region).toContain(STUB_DELETED);
    // Exactly one heading with that title remains in the doc — the authored one.
    expect(r.next.split(STUB_CREATED).length - 1).toBe(1);
    // A second sync of the result is current.
    expect(syncDocText(r.next, buildSliceRegions(model, [2], { authoredDoc: r.next })).status).toBe("ok");
  });

  it("a scenario with its own title covers a stub when its Given names the event and the block names the field", () => {
    const { model, doc } = freshDoc();
    const authored = withScenarios(doc, SCENARIO_CREATED, SCENARIO_DELETED_OWN_TITLE);
    const r = syncDocText(authored, buildSliceRegions(model, [2], { authoredDoc: authored }));
    expect(r.status).toBe("stale");
    const region = viewRegion(r.next);
    expect(region).not.toContain(STUBS_HEADER);
    expect(region).not.toContain("### Scenario:");
    expect(region).toContain("Collection of `AttributeValue`, fed by");
    // Nothing is left for the placeholder warning to report in the view region.
    expect(generatedRegionPlaceholders(r.next).map((p) => p.region)).not.toContain("em-slice-view");
  });

  it("a Given naming the event without the field in the block does not cover the stub", () => {
    const authored = authoredScenarios(
      ["## Scenarios", "### Scenario: Something else", "- **Given:**", "  - `Attribute Value Deleted`", "- **When:**", "  - queried", "- **Then:**", "  - the count drops", ""].join("\n"),
    );
    expect(coversCollectionStub(authored, "values", "Attribute Value Deleted")).toBe(false);
    expect(coversCollectionStub(authored, "values", "Attribute Value Created")).toBe(false);
  });

  it("title matching ignores case, spacing and punctuation", () => {
    const authored = authoredScenarios(
      ["## Scenarios", "### Scenario: VALUES after attribute-value-created", "- **Given:**", "  - x", "- **When:**", "  - y", "- **Then:**", "  - z", ""].join("\n"),
    );
    expect(coversCollectionStub(authored, "values", "Attribute Value Created")).toBe(true);
  });

  it("runSliceSync (the CLI/MCP path) reads the doc it syncs: the issue's shape end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-gh368-"));
    try {
      mkdirSync(join(dir, "slices"));
      const { doc } = freshDoc();
      writeFileSync(join(dir, "model.em"), MODEL);
      writeFileSync(join(dir, "slices", "attributes.md"), withScenarios(doc, SCENARIO_CREATED));
      const { model, refs } = compile(MODEL);
      const first = runSliceSync(model, refs, dir, undefined, false);
      if (!first.ok) throw new Error(first.message);
      expect(first.docs.find((d) => d.key === "attributes")!.status).toBe("synced");
      const after = readFileSync(join(dir, "slices", "attributes.md"), "utf8");
      expect(viewRegion(after)).not.toContain(STUB_CREATED);
      expect(viewRegion(after)).toContain(STUB_DELETED);
      const second = runSliceSync(model, refs, dir, undefined, true);
      if (!second.ok) throw new Error(second.message);
      expect(second.docs.find((d) => d.key === "attributes")!.status).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("duplicateScenarioTitles (GH #368)", () => {
  it("counts only ### Scenario: headings inside the ## Scenarios section, stripped of case/spacing/punctuation", () => {
    const body = [
      "## Read Model / View",
      "### Scenario: values after Attribute Value Created",
      "## Scenarios (Given / When / Then)",
      "### Scenario: values after Attribute Value Created",
      "- **Given:**",
      "  - a",
      "### Scenario: Values after attribute value created",
      "- **Given:**",
      "  - b",
      "### Scenario: Another",
      "## Alternate & Error Flows",
      "### Scenario: Another",
    ].join("\n");
    expect(duplicateScenarioTitles(body)).toEqual([{ title: "values after Attribute Value Created", count: 2 }]);
  });
});

describe("slice-doc/scenario-title-duplicate (GH #368)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-gh368-validate-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const diagsFor = (doc: string) => {
    writeFileSync(join(dir, "slices", "attributes.md"), doc);
    const { model, refs } = compile(MODEL);
    return validateDocModelConsistency(model, refs, dir).filter((d) => d.code === "slice-doc/scenario-title-duplicate");
  };

  it("warns once per title that two authored scenarios share", () => {
    const { doc } = freshDoc();
    const diags = diagsFor(withScenarios(doc, SCENARIO_CREATED, SCENARIO_CREATED.replace("value V", "value W")));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].refs).toEqual(["attributes"]);
    expect(diags[0].message).toContain('scenario title "values after Attribute Value Created" appears 2 times');
  });

  it("is silent when the authored scenario shares its title only with the stub in the generated region", () => {
    const { doc } = freshDoc();
    // The fresh doc still holds the stub under the view table AND the authored copy — the
    // reporter's exact state before the next sync.
    expect(diagsFor(withScenarios(doc, SCENARIO_CREATED))).toEqual([]);
  });

  it("is silent on distinct titles", () => {
    const { doc } = freshDoc();
    expect(diagsFor(withScenarios(doc, SCENARIO_CREATED, SCENARIO_DELETED_OWN_TITLE))).toEqual([]);
  });
});
