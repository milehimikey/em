// SPDX-License-Identifier: MIT
// Coverage for src/model/model.ts's normalization concerns beyond what's already
// exercised indirectly through the parser/validate/export suites: the `types`/
// `typesByName` registry `normalize()` builds from `type` declarations (MIL-64),
// and the shared `resolveTypeRef()` resolver.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize, resolveTypeRef } from "../src/model/model.js";

const normalizeOf = (src: string) => normalize(parse(src));

describe("type declarations registry", () => {
  it("populates `types` in document order and `typesByName` by normalized name", () => {
    const model = normalizeOf(`
type Money { amount: int, currency: String }
type Address { line1: String }
`);
    expect(model.types.map((t) => t.name)).toEqual(["Money", "Address"]);
    expect(model.typesByName.get("money")?.name).toBe("Money");
    expect(model.typesByName.get("address")?.name).toBe("Address");
  });

  it("normalizes a multi-word type name the same way element names are normalized", () => {
    const model = normalizeOf(`type Quote Accepted Line { lineId: UUID }`);
    expect(model.typesByName.get("quote accepted line")?.name).toBe("Quote Accepted Line");
  });

  it("dedupes a duplicate type name's id but keeps `typesByName` pointed at the first declaration", () => {
    const model = normalizeOf(`
type Money { amount: int }
type Money { cents: long }
`);
    expect(model.types).toHaveLength(2);
    expect(model.types[0].id).not.toBe(model.types[1].id);
    expect(model.typesByName.get("money")?.id).toBe(model.types[0].id);
    expect(model.typesByName.get("money")?.fields).toEqual([{ name: "amount", type: "int" }]);
  });

  it("keeps a type's id namespace separate from an element's — a type and an element may share a name", () => {
    const model = normalizeOf(`
type Money { amount: int }
slice "S" {
  event Money Recorded { amount: int }
}
`);
    // Both "Money" (type) and "Money Recorded" (event) coexist without id collisions;
    // more directly, an identically-named element wouldn't throw or get renamed.
    expect(model.types[0].name).toBe("Money");
    expect(model.elements[0].name).toBe("Money Recorded");
  });

  it("returns empty types/typesByName for a model with no `type` declarations", () => {
    const model = normalizeOf(`slice "S" {\n  command Do Thing\n}`);
    expect(model.types).toEqual([]);
    expect(model.typesByName.size).toBe(0);
  });
});

describe("resolveTypeRef", () => {
  const model = normalizeOf(`type QuoteAcceptedLine { lineId: UUID }`);

  it("resolves a bare reference to a declared type", () => {
    const ref = resolveTypeRef("QuoteAcceptedLine", model.typesByName);
    expect(ref?.typeDecl.name).toBe("QuoteAcceptedLine");
    expect(ref?.array).toBe(false);
  });

  it("resolves an array reference (`Name[]`) to a declared type, flagging array: true", () => {
    const ref = resolveTypeRef("QuoteAcceptedLine[]", model.typesByName);
    expect(ref?.typeDecl.name).toBe("QuoteAcceptedLine");
    expect(ref?.array).toBe(true);
  });

  it("resolves case- and whitespace-insensitively", () => {
    expect(resolveTypeRef("quoteacceptedline", model.typesByName)?.typeDecl.name).toBe("QuoteAcceptedLine");
    expect(resolveTypeRef("QUOTEACCEPTEDLINE", model.typesByName)?.typeDecl.name).toBe("QuoteAcceptedLine");
    expect(resolveTypeRef("  QuoteAcceptedLine  ", model.typesByName)?.typeDecl.name).toBe("QuoteAcceptedLine");
    expect(resolveTypeRef("  QuoteAcceptedLine[]  ", model.typesByName)?.array).toBe(true);
  });

  it("resolves to null for a similarly-named but distinct string (no fuzzy match)", () => {
    expect(resolveTypeRef("QuoteAcceptedLin", model.typesByName)).toBeNull();
    expect(resolveTypeRef("QuoteAcceptedLines", model.typesByName)).toBeNull();
  });

  it("resolves to null for an ordinary free-text type that isn't declared — no primitive whitelist", () => {
    expect(resolveTypeRef("Money", model.typesByName)).toBeNull();
    expect(resolveTypeRef("UUID", model.typesByName)).toBeNull();
    expect(resolveTypeRef("List<LineItem>", model.typesByName)).toBeNull();
  });

  it("resolves to null for undefined or empty/whitespace-only type strings", () => {
    expect(resolveTypeRef(undefined, model.typesByName)).toBeNull();
    expect(resolveTypeRef("", model.typesByName)).toBeNull();
    expect(resolveTypeRef("   ", model.typesByName)).toBeNull();
    expect(resolveTypeRef("[]", model.typesByName)).toBeNull(); // array suffix with no base name
  });
});
