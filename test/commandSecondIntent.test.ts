// SPDX-License-Identifier: MIT
// GH #286: advisory `command-second-intent` lint.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateInvariants, conditionalField } from "../src/catalog/invariantsValidate.js";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { computeRefs } from "../src/model/refs.js";

const MODEL = `model "PIM"

slice "Create Product" {
  ui Form
  command Create Product { productId: UUID, parentId: UUID } note "slices/create-product.md"
  invariant INV-PIM-1 "If \`parentId\` is set, the parent must exist"
  invariant INV-PIM-2 "When parentId is present, the SKU must be unique per parent"
  invariant INV-PIM-3 "Only if parentId is provided may attributes be inherited"
  invariant INV-PIM-4 "A product name is required"
  event Product Created { productId: UUID } public
}
`;

describe("command-second-intent (GH #286)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-second-intent-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (src: string) => {
    const model = normalize(parse(src));
    return validateInvariants(model, computeRefs(model), dir).filter((d) => d.code === "command-second-intent");
  };

  it("fires once with the command ref and every invariant ID", () => {
    const d = run(MODEL);
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
    expect(d[0].refs).toEqual(["create-product/command.create-product", "INV-PIM-1", "INV-PIM-2", "INV-PIM-3"]);
    expect(d[0].message).toContain('command "Create Product"');
    expect(d[0].message).toContain("`parentId`");
    expect(d[0].message).toContain("bare repeat of the event is legal");
  });

  it("one conditional invariant is not a second intent", () => {
    expect(run(MODEL.replace(/ {2}invariant INV-PIM-[23].*\n/g, ""))).toEqual([]);
  });

  it("conditionals on different fields do not group", () => {
    expect(run(MODEL.replace("When parentId is present", "When sku is present").replace("Only if parentId", "Only if barcode"))).toEqual([]);
  });

  it("counts doc-declared invariants of the bound doc", () => {
    const src = MODEL.replace(/ {2}invariant INV-PIM-.*\n/g, "");
    writeFileSync(
      join(dir, "slices", "create-product.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: Catalog\nstatus: implemented\nversion: 1\nimplementedIn: https://example.invalid/pr/1\n" +
        "ratifiedBy: Ada\nratifiedOn: 2026-10-01\n---\n# Slice: Create Product\n\n" +
        "## Invariants / Business Rules\n- **INV-1:** Unless `variantOf` is given, a SKU is required\n- **INV-2:** If variantOf is set, the parent must exist\n",
    );
    const d = run(src);
    expect(d).toHaveLength(1);
    expect(d[0].refs).toEqual(["create-product/command.create-product", "INV-1", "INV-2"]);
  });

  it("plain guard clauses are not a second intent (Unless / Only if without the set-words tail)", () => {
    const guard = (a: string, b: string) =>
      MODEL.replace(/ {2}invariant INV-PIM-[1-4].*\n/g, `  invariant INV-PIM-1 "${a}"\n  invariant INV-PIM-2 "${b}"\n`);
    expect(run(guard("Unless quantity is positive, reject", "Unless quantity exceeds stock, accept"))).toEqual([]);
    expect(run(guard("Only if the order is confirmed may it ship", "Only if the order is paid may it ship"))).toEqual([]);
  });

  it("accepts the **INV-X (note):** label form in docs", () => {
    const src = MODEL.replace(/ {2}invariant INV-PIM-.*\n/g, "");
    writeFileSync(
      join(dir, "slices", "create-product.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: Catalog\nstatus: implemented\nversion: 1\nimplementedIn: https://example.invalid/pr/1\n" +
        "ratifiedBy: Ada\nratifiedOn: 2026-10-01\n---\n# Slice: Create Product\n\n" +
        "## Invariants / Business Rules\n- **INV-1 (variant):** If variantOf is set, the parent must exist\n- **INV-2:** When VariantOf is present, SKU is unique\n",
    );
    const d = run(src);
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("`variantOf`");
  });

  it("conditionalField recognises the pattern list", () => {
    expect(conditionalField("If `a` is not null, x")).toBe("a");
    expect(conditionalField("When the b is supplied, x")).toBe("b");
    expect(conditionalField("Unless c is given")).toBe("c");
    expect(conditionalField("A total must be positive")).toBeNull();
    expect(conditionalField(null)).toBeNull();
  });
});
