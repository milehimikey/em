// SPDX-License-Identifier: MIT
// Coverage for `em glossary`'s term collection and cross-model conflict
// detection (src/model/glossary.ts): term aggregation across independent
// models, kind conflicts, field-type conflicts, and the cases that must NOT
// fire (single-model duplicates, persona/context casing, `view X again`).
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import {
  buildGlossary,
  detectKindConflicts,
  detectFieldTypeConflicts,
  hasConflicts,
  formatConflictLine,
  formatGlossarySummary,
  GlossaryModelInput,
} from "../src/model/glossary.js";

const input = (label: string, src: string): GlossaryModelInput => ({ label, model: compile(src).model });

describe("buildGlossary", () => {
  it("collects element names, field names, personas, and contexts across models", () => {
    const a = input(
      "a.em",
      `
persona Customer
context Sales
slice "Submit" {
  ui Checkout Screen @Customer
  command Submit Order { total: Money }
  event Order Submitted @Sales { total: Money }
}
`,
    );
    const glossary = buildGlossary([a]);

    expect(glossary.models).toEqual(["a.em"]);
    expect(glossary.elements.map((t) => t.key)).toEqual(
      ["checkout screen", "order submitted", "submit order"].sort(),
    );
    expect(glossary.fields.map((t) => t.key)).toEqual(["total"]);
    expect(glossary.personas.map((t) => t.name)).toEqual(["Customer"]);
    expect(glossary.contexts.map((t) => t.name)).toEqual(["Sales"]);
  });

  it("dedupes a model's own personas/contexts by normalized key, ignoring model.ts's case-sensitive array dedup", () => {
    // Two ui elements tagged with differently-cased personas: model.ts's `personas`
    // array (case-sensitive includes()) ends up with both "Customer" and "customer".
    const a = input(
      "a.em",
      `
slice "S" {
  ui Screen One @Customer
  ui Screen Two @customer
}
`,
    );
    const glossary = buildGlossary([a]);
    expect(glossary.personas).toHaveLength(1);
    expect(glossary.personas[0].occurrences).toHaveLength(1);
  });

  it("sorts terms by normalized key", () => {
    const a = input(
      "a.em",
      `
slice "S" {
  command Zebra Order
  event Apple Picked
}
`,
    );
    const glossary = buildGlossary([a]);
    expect(glossary.elements.map((t) => t.key)).toEqual(["apple picked", "zebra order"]);
  });
});

describe("detectKindConflicts", () => {
  it("does not fire within a single model, even if a name is reused across kinds", () => {
    // Same normalized name, two different kinds, but only one model — this is
    // validate.ts's "ambiguous names" territory, not a cross-model conflict.
    const a = input(
      "a.em",
      `
slice "S" {
  command Order
  event Order Placed
}
slice "T" {
  view Order
}
`,
    );
    const conflicts = detectKindConflicts(buildGlossary([a]));
    expect(conflicts).toEqual([]);
  });

  it("does not fire when the same term is the same kind across models", () => {
    const a = input(
      "a.em",
      `
slice "S" {
  event Order Placed
}
`,
    );
    const b = input(
      "b.em",
      `
slice "T" {
  event Order Placed
}
`,
    );
    const conflicts = detectKindConflicts(buildGlossary([a, b]));
    expect(conflicts).toEqual([]);
  });

  it("fires when the same term is a different kind across ≥2 models", () => {
    const a = input(
      "a.em",
      `
slice "Checkout" {
  event Order
}
`,
    );
    const b = input(
      "b.em",
      `
slice "Billing" {
  view Order
}
`,
    );
    const conflicts = detectKindConflicts(buildGlossary([a, b]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].term).toBe("Order");
    expect(conflicts[0].occurrences).toHaveLength(2);
    expect(formatConflictLine(conflicts[0])).toBe(
      'kind-conflict "Order": event in a.em:3 (slice "Checkout"), view in b.em:3 (slice "Billing")',
    );
  });

  it("does not fire on a `view X again` instance — same kind, expected", () => {
    const a = input(
      "a.em",
      `
slice "S" {
  event Order Placed
  view Order Summary from "Order Placed"
}
slice "T" {
  event Order Shipped
  view Order Summary again
}
`,
    );
    const conflicts = detectKindConflicts(buildGlossary([a]));
    expect(conflicts).toEqual([]);
  });
});

describe("detectFieldTypeConflicts", () => {
  it("does not fire when a field is untyped or identically typed across models", () => {
    const a = input(
      "a.em",
      `
slice "S" {
  command Submit { total: Money }
}
`,
    );
    const b = input(
      "b.em",
      `
slice "T" {
  event Submitted { total: Money }
}
`,
    );
    expect(detectFieldTypeConflicts(buildGlossary([a, b]))).toEqual([]);
  });

  it("fires when the same field name is typed differently across ≥2 models", () => {
    const a = input(
      "a.em",
      `
slice "Checkout" {
  event Order Placed { total: Money }
}
`,
    );
    const b = input(
      "b.em",
      `
slice "Billing" {
  view Order Summary { total: number }
}
`,
    );
    const conflicts = detectFieldTypeConflicts(buildGlossary([a, b]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].term).toBe("total");
    expect(formatConflictLine(conflicts[0])).toBe(
      'field-type-conflict "total": Money on event "Order Placed" in a.em:3, number on view "Order Summary" in b.em:3',
    );
  });

  it("fires when the same field name is typed in one model and untyped in another", () => {
    const a = input(
      "a.em",
      `
slice "Checkout" {
  event Order Placed { total: Money }
}
`,
    );
    const b = input(
      "b.em",
      `
slice "Billing" {
  view Order Summary { total }
}
`,
    );
    const conflicts = detectFieldTypeConflicts(buildGlossary([a, b]));
    expect(conflicts).toHaveLength(1);
    expect(formatConflictLine(conflicts[0])).toContain("(untyped) on view");
  });
});

describe("hasConflicts", () => {
  it("reflects whether any conflicts were found", () => {
    expect(hasConflicts([])).toBe(false);
    const a = input(
      "a.em",
      `
slice "Checkout" {
  event Order
}
`,
    );
    const b = input(
      "b.em",
      `
slice "Billing" {
  view Order
}
`,
    );
    expect(hasConflicts(detectKindConflicts(buildGlossary([a, b])))).toBe(true);
  });
});

describe("formatGlossarySummary", () => {
  it("reports scale and 'no conflicts' when clean", () => {
    const a = input(
      "a.em",
      `
slice "S" {
  command Submit Order
}
`,
    );
    const glossary = buildGlossary([a]);
    // 3 terms: the "Submit Order" command, plus the default "User" persona and
    // "Domain" context every model gets when none are declared (model.ts's
    // DEFAULT_PERSONA/DEFAULT_CONTEXT).
    expect(formatGlossarySummary(glossary, [])).toBe("1 model, 3 terms, 0 conflicts\n\nno conflicts");
  });

  it("reports scale and every conflict line when dirty", () => {
    const a = input(
      "a.em",
      `
slice "Checkout" {
  event Order
}
`,
    );
    const b = input(
      "b.em",
      `
slice "Billing" {
  view Order
}
`,
    );
    const glossary = buildGlossary([a, b]);
    const conflicts = detectKindConflicts(glossary);
    const report = formatGlossarySummary(glossary, conflicts);
    // 3 terms: the shared "Order" element, plus the default "User" persona and
    // "Domain" context — each shared across both models, so each is one glossary
    // term (with two occurrences), not two.
    expect(report).toBe(
      '2 models, 3 terms, 1 conflict\n\n' +
        'kind-conflict "Order": event in a.em:3 (slice "Checkout"), view in b.em:3 (slice "Billing")',
    );
  });
});
