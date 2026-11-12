// SPDX-License-Identifier: MIT
// Coverage for src/model/model.ts's normalization concerns beyond what's already
// exercised indirectly through the parser/validate/export suites: the `types`/
// `typesByName` registry `normalize()` builds from `type` declarations (MIL-64),
// and the shared `resolveTypeRef()` resolver.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser/parser.js";
import { normalize, resolveEnumRef, resolvePublicType, resolveScalarRef, resolveTypeRef } from "../src/model/model.js";

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

describe("scalar declarations registry (GH #477)", () => {
  it("populates `scalars` in document order and `scalarsByName` by normalized name", () => {
    const model = normalizeOf(`
scalar OrderId: uuid
scalar Sku: string
`);
    expect(model.scalars.map((s) => s.name)).toEqual(["OrderId", "Sku"]);
    expect(model.scalarsByName.get("orderid")?.base).toBe("uuid");
    expect(model.scalarsByName.get("sku")?.base).toBe("string");
  });

  it("dedupes a duplicate scalar name's id but keeps `scalarsByName` pointed at the first declaration", () => {
    const model = normalizeOf(`
scalar OrderId: uuid
scalar OrderId: string
`);
    expect(model.scalars).toHaveLength(2);
    expect(model.scalars[0].id).not.toBe(model.scalars[1].id);
    expect(model.scalarsByName.get("orderid")?.base).toBe("uuid");
  });

  it("dedupes a scalar's id within its own registry, independent of a same-named type's or element's own dedup counter", () => {
    // A scalar and a type sharing a name is a validate error (scalar-type-name-collision) —
    // this exercises normalize() alone, before validation, and only the dedup-independence
    // claim: each registry (types/scalars/elements) starts its own `~2`-style counter, so one
    // colliding name in one registry never bumps the *other* registry's id for the same name.
    const model = normalizeOf(`
scalar Money: string
type Money { amount: int }
slice "S" {
  event Money Recorded { amount: int }
}
`);
    expect(model.scalars[0].id).toBe("money");
    expect(model.types[0].id).toBe("money");
    expect(model.elements[0].id).not.toBe("money");
  });

  it("returns empty scalars/scalarsByName for a model with no `scalar` declarations", () => {
    const model = normalizeOf(`slice "S" {\n  command Do Thing\n}`);
    expect(model.scalars).toEqual([]);
    expect(model.scalarsByName.size).toBe(0);
  });
});

describe("resolveScalarRef", () => {
  const model = normalizeOf(`scalar OrderId: uuid`);

  it("resolves a bare reference to a declared scalar", () => {
    const ref = resolveScalarRef("OrderId", model.scalarsByName);
    expect(ref?.scalarDecl.name).toBe("OrderId");
    expect(ref?.array).toBe(false);
  });

  it("resolves an array reference (`Name[]`), flagging array: true", () => {
    const ref = resolveScalarRef("OrderId[]", model.scalarsByName);
    expect(ref?.scalarDecl.name).toBe("OrderId");
    expect(ref?.array).toBe(true);
  });

  it("resolves case- and whitespace-insensitively", () => {
    expect(resolveScalarRef("orderid", model.scalarsByName)?.scalarDecl.name).toBe("OrderId");
    expect(resolveScalarRef("  OrderId  ", model.scalarsByName)?.scalarDecl.name).toBe("OrderId");
  });

  it("resolves to null for an undeclared name, and for undefined/empty type strings", () => {
    expect(resolveScalarRef("Sku", model.scalarsByName)).toBeNull();
    expect(resolveScalarRef(undefined, model.scalarsByName)).toBeNull();
    expect(resolveScalarRef("", model.scalarsByName)).toBeNull();
  });
});

describe("resolvePublicType: identity scalars (GH #477)", () => {
  it("resolves a declared scalar to kind identity, carrying the matched table base and its tsType", () => {
    const model = normalizeOf(`scalar OrderId: uuid`);
    const r = resolvePublicType("OrderId", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r).toEqual({ kind: "identity", scalarDecl: model.scalars[0], base: "uuid", tsType: "Uuid", array: false });
  });

  it("resolves the array form, flagging array: true", () => {
    const model = normalizeOf(`scalar Sku: string`);
    const r = resolvePublicType("Sku[]", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r).toMatchObject({ kind: "identity", base: "string", tsType: "string", array: true });
  });

  it("matches the base case-insensitively", () => {
    const model = normalizeOf(`scalar OrderId: UUID`);
    const r = resolvePublicType("OrderId", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r).toMatchObject({ kind: "identity", base: "uuid" });
  });

  it("a declared type and a declared scalar never both match (collision is a validate error, not resolved here)", () => {
    const model = normalizeOf(`
type Money { amount: int }
scalar Money: string
`);
    // Declared type wins the (invalid, collision-guarded) tie — see model/validate.ts's
    // scalar-type-name-collision for the error this model would actually raise.
    const r = resolvePublicType("Money", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r?.kind).toBe("declared");
  });

  it("falls back to the fixed scalar table for an ordinary table name", () => {
    const model = normalizeOf(`scalar OrderId: uuid`);
    const r = resolvePublicType("string", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r).toEqual({ kind: "scalar", scalar: "string", tsType: "string", array: false });
  });

  it("resolves to null for an undeclared name", () => {
    const model = normalizeOf(`scalar OrderId: uuid`);
    expect(resolvePublicType("Money", model.typesByName, model.scalarsByName, model.enumsByName)).toBeNull();
  });
});

describe("enum declarations registry (GH #478)", () => {
  it("populates `enums` in document order and `enumsByName` by normalized name", () => {
    const model = normalizeOf(`
enum OrderStatus { placed, shipped }
enum PaymentStatus { pending, paid }
`);
    expect(model.enums.map((e) => e.name)).toEqual(["OrderStatus", "PaymentStatus"]);
    expect(model.enumsByName.get("orderstatus")?.members).toEqual(["placed", "shipped"]);
    expect(model.enumsByName.get("paymentstatus")?.members).toEqual(["pending", "paid"]);
  });

  it("dedupes a duplicate enum name's id but keeps `enumsByName` pointed at the first declaration", () => {
    const model = normalizeOf(`
enum OrderStatus { placed }
enum OrderStatus { shipped }
`);
    expect(model.enums).toHaveLength(2);
    expect(model.enums[0].id).not.toBe(model.enums[1].id);
    expect(model.enumsByName.get("orderstatus")?.members).toEqual(["placed"]);
  });

  it("dedupes an enum's id within its own registry, independent of a same-named type's or scalar's own dedup counter", () => {
    // An enum sharing a name with a `type` or `scalar` is a validate error (enum-name-collision)
    // — this exercises normalize() alone, before validation, and only the dedup-independence
    // claim: each registry starts its own `~2`-style counter.
    const model = normalizeOf(`
enum Money { dollars, cents }
type Money { amount: int }
scalar MoneyAlias: string
`);
    expect(model.enums[0].id).toBe("money");
    expect(model.types[0].id).toBe("money");
  });

  it("returns empty enums/enumsByName for a model with no `enum` declarations", () => {
    const model = normalizeOf(`slice "S" {\n  command Do Thing\n}`);
    expect(model.enums).toEqual([]);
    expect(model.enumsByName.size).toBe(0);
  });
});

describe("resolveEnumRef", () => {
  const model = normalizeOf(`enum OrderStatus { placed, shipped }`);

  it("resolves a bare reference to a declared enum", () => {
    const ref = resolveEnumRef("OrderStatus", model.enumsByName);
    expect(ref?.enumDecl.name).toBe("OrderStatus");
    expect(ref?.array).toBe(false);
  });

  it("resolves an array reference (`Name[]`), flagging array: true", () => {
    const ref = resolveEnumRef("OrderStatus[]", model.enumsByName);
    expect(ref?.enumDecl.name).toBe("OrderStatus");
    expect(ref?.array).toBe(true);
  });

  it("resolves case- and whitespace-insensitively", () => {
    expect(resolveEnumRef("orderstatus", model.enumsByName)?.enumDecl.name).toBe("OrderStatus");
    expect(resolveEnumRef("  OrderStatus  ", model.enumsByName)?.enumDecl.name).toBe("OrderStatus");
  });

  it("resolves to null for an undeclared name, and for undefined/empty type strings", () => {
    expect(resolveEnumRef("PaymentStatus", model.enumsByName)).toBeNull();
    expect(resolveEnumRef(undefined, model.enumsByName)).toBeNull();
    expect(resolveEnumRef("", model.enumsByName)).toBeNull();
  });
});

describe("resolvePublicType: declared enums (GH #478)", () => {
  it("resolves a declared enum to kind enum, carrying the matched EnumDecl", () => {
    const model = normalizeOf(`enum OrderStatus { placed, shipped }`);
    const r = resolvePublicType("OrderStatus", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r).toEqual({ kind: "enum", enumDecl: model.enums[0], array: false });
  });

  it("resolves the array form, flagging array: true", () => {
    const model = normalizeOf(`enum OrderStatus { placed, shipped }`);
    const r = resolvePublicType("OrderStatus[]", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r).toMatchObject({ kind: "enum", array: true });
  });

  it("a declared type wins over a same-named enum (collision is a validate error, not resolved here)", () => {
    const model = normalizeOf(`
type Status { code: int }
enum Status { ok, error }
`);
    const r = resolvePublicType("Status", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r?.kind).toBe("declared");
  });

  it("a declared scalar wins over a same-named enum (collision is a validate error, not resolved here)", () => {
    const model = normalizeOf(`
scalar Status: string
enum Status { ok, error }
`);
    const r = resolvePublicType("Status", model.typesByName, model.scalarsByName, model.enumsByName);
    expect(r?.kind).toBe("identity");
  });

  it("resolves to null for an undeclared name", () => {
    const model = normalizeOf(`enum OrderStatus { placed, shipped }`);
    expect(resolvePublicType("PaymentStatus", model.typesByName, model.scalarsByName, model.enumsByName)).toBeNull();
  });
});
