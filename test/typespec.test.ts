// SPDX-License-Identifier: MIT
// Coverage for `em typespec`'s POC generator (src/emit/typespec.ts, MIL-159): scoping
// (public events/views, commands in a slice with one of either), the type-mapping strategy
// (declared types, scalar table, arrays, unmapped fallback), tag/renamedFrom/assigned as doc
// comments (never decorators), identifier shaping/dedup, determinism, and a golden-output run
// against the real examples/order-fulfillment project. The `@typespec/compiler` block at the
// bottom actually compiles the generated text — skipped, not failed, if that (devDependency-
// only, never shipped) package isn't installed, per MIL-159's "skip-if-absent" instruction.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildTypeSpec } from "../src/emit/typespec.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PATH = join(ROOT, "examples/order-fulfillment/order-fulfillment.em");

const generate = (src: string, path = "model.em") => {
  const { model, refs, diagnostics } = compile(src);
  return buildTypeSpec(model, refs, diagnostics, src, path);
};

describe("header", () => {
  it("marks the output EXPERIMENTAL/POC and names its own regeneration command", () => {
    const { text } = generate(`slice "S" {\n  command Do Thing\n}`, "some/path.em");
    expect(text).toContain("EXPERIMENTAL / POC (MIL-159)");
    expect(text).toContain("Source: some/path.em (sha256 ");
    expect(text).toContain("em typespec some/path.em");
  });

  it("hashes the exact source text, same convention as `em export`", () => {
    const src = `slice "S" {\n  command Do Thing\n}`;
    const { text } = generate(src, "m.em");
    const sha = createHash("sha256").update(src, "utf8").digest("hex");
    expect(text).toContain(`sha256 ${sha}`);
  });
});

describe("scoping", () => {
  it("excludes a non-public event/view and any command in a slice with no public element", () => {
    const { text } = generate(`
slice "Internal" {
  ui Screen @Customer
  command Do Thing { a }
  event Thing Done @Domain { a }
}
`);
    expect(text).not.toContain("model ThingDone");
    expect(text).not.toContain("interface Commands");
    // No `model "Name"` header line in this fixture — the parser's own default ("Event
    // Model", src/parser/parser.ts) is what `buildTypeSpec` PascalCases into a namespace.
    expect(text.trim().endsWith("namespace EventModel {}")).toBe(true);
  });

  it("includes a public event as a model, and its slice's command as an operation", () => {
    const { text } = generate(`
slice "Public Thing" {
  ui Screen @Customer
  command Do Thing { a: string }
  event Thing Done @Domain public { a: string }
}
`);
    expect(text).toContain("model ThingDone {");
    expect(text).toContain("interface Commands {");
    expect(text).toContain("op doThing(a: string): void;");
  });

  it("includes a public view as a model plus a no-arg accessor op", () => {
    const { text } = generate(`
slice "Emit" {
  command Do Thing
  event Thing Done @Domain
}
slice "Read It" {
  view Things public from "Thing Done" { a: string }
}
`);
    expect(text).toContain("model Things {");
    expect(text).toContain("interface Views {");
    expect(text).toContain("op getThings(): Things;");
    // "Do Thing"'s own slice has no public event/view, so it stays out of the contract.
    expect(text).not.toContain("interface Commands");
  });

  it("excludes a private event sitting in the same slice as a public one", () => {
    const { text } = generate(`
slice "Mixed" {
  command Do Thing
  event Public One @Domain public
  event Private Two @Domain
}
`);
    expect(text).toContain("model PublicOne {");
    expect(text).not.toContain("model PrivateTwo");
  });

  it("folds a repeated public view instance (`again`) into its first declaration", () => {
    const { text } = generate(`
slice "First" {
  command Do Thing
  event Thing Done @Domain
}
slice "V1" {
  view Board public from "Thing Done" { a: string }
}
slice "V2" {
  view Board public again from "Thing Done"
}
`);
    const occurrences = text.match(/model Board \{/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});

describe("type mapping", () => {
  it("maps common scalars case-insensitively", () => {
    const { text } = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: string
    b: int
    c: long
    d: boolean
    e: float
    f: double
    g: Money
    h: UUID
    i: Instant
    j: Date
  }
}
`);
    expect(text).toContain("a: string;");
    expect(text).toContain("b: int32;");
    expect(text).toContain("c: int64;");
    expect(text).toContain("d: boolean;");
    expect(text).toContain("e: float32;");
    expect(text).toContain("f: float64;");
    expect(text).toContain("g: decimal;");
    expect(text).toContain("h: string;");
    expect(text).toContain("i: utcDateTime;");
    expect(text).toContain("j: plainDate;");
  });

  it("maps `Type[]` and `List<Type>` array spellings to a TypeSpec array of the mapped scalar", () => {
    const { text } = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: string[]
    b: List<string>
  }
}
`);
    expect(text).toContain("a: string[];");
    expect(text).toContain("b: string[];");
  });

  it("maps a declared `type` reference (bare and array) to its generated model, not a scalar", () => {
    const result = generate(`
type Money2 { cents: long }
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: Money2
    b: Money2[]
  }
}
`);
    expect(result.text).toContain("model Money2 {");
    expect(result.text).toContain("cents: int64;");
    expect(result.text).toContain("a: Money2;");
    expect(result.text).toContain("b: Money2[];");
  });

  it("only emits declared types reachable from an included element's fields", () => {
    const result = generate(`
type Used { x: string }
type Unused { y: string }
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a: Used }
}
`);
    expect(result.text).toContain("model Used {");
    expect(result.text).not.toContain("model Unused");
  });

  it("maps an untyped field to `unknown` without flagging it as unmapped", () => {
    const result = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a }
}
`);
    expect(result.text).toContain("a: unknown;");
    expect(result.unmappedTypes).toEqual([]);
  });

  it("maps an unrecognized declared type to `unknown` and records it as unmapped", () => {
    const result = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a: SomeWeirdType }
}
`);
    expect(result.text).toContain("a: unknown;");
    expect(result.unmappedTypes).toHaveLength(1);
    expect(result.unmappedTypes[0]).toContain("SomeWeirdType");
    expect(result.unmappedTypes[0]).toContain("emitted as `unknown`");
  });

  it("keeps a `List<X>` wrapper's arity (`unknown[]`) even when X itself doesn't map", () => {
    const result = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a: List<SomeWeirdType> }
}
`);
    expect(result.text).toContain("a: unknown[];");
  });
});

describe("em-specific metadata becomes doc comments, never decorators", () => {
  it("records an identity tag, a composite tag, and an external tag as /** ... */ text", () => {
    const { text } = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: UUID tag
    b: string
  }
  tag comboKey from a, b
  tag hashKey external "some computed hash"
}
`);
    expect(text).toContain("/** DCB identity tag */");
    expect(text).toContain("DCB composite tag `comboKey` from a, b");
    expect(text).toContain('DCB external tag `hashKey`: some computed hash');
    expect(text).not.toMatch(/@tag\(/);
  });

  it("records element- and field-level `renamed from` as doc comments", () => {
    const { text } = generate(`
slice "S" {
  command Do Thing
  event Thing Done renamed from "Thing Was Done" @Domain public {
    a: string renamed from "oldA"
  }
}
`);
    expect(text).toContain('renamed from "Thing Was Done"');
    expect(text).toContain('renamed from "oldA"');
    expect(text).not.toMatch(/@renamedFrom/i);
  });

  it("records `assigned` as a doc comment", () => {
    const { text } = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: UUID assigned
    b: string
  }
}
`);
    expect(text).toContain("system-assigned — not supplied by the triggering command");
    expect(text).not.toMatch(/@assigned/i);
  });
});

describe("identifier shaping", () => {
  it("PascalCases free-text element names into model/interface identifiers", () => {
    const { text } = generate(`
slice "S" {
  command Do The Thing
  event Big Thing Happened @Domain public
}
`);
    expect(text).toContain("model BigThingHappened {");
    expect(text).toContain("op doTheThing(");
  });

  it("dedupes two elements whose names collide once PascalCased", () => {
    const { text } = generate(`
slice "S1" {
  command Do Thing
  event Order Placed @Domain public
}
slice "S2" {
  command Do Other Thing
  event order-placed @Domain public
}
`);
    expect(text).toContain("model OrderPlaced {");
    expect(text).toContain("model OrderPlaced_2 {");
  });

  it("backtick-quotes a field name that isn't a bare identifier", () => {
    const { text } = generate(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public { weird field: string }
}
`);
    expect(text).toContain("`weird field`: string;");
  });
});

describe("determinism", () => {
  it("the same source always produces byte-identical output", () => {
    const src = readFileSync(EXAMPLE_PATH, "utf8");
    const a = generate(src, "examples/order-fulfillment/order-fulfillment.em").text;
    const b = generate(src, "examples/order-fulfillment/order-fulfillment.em").text;
    expect(a).toBe(b);
  });
});

describe("golden: examples/order-fulfillment", () => {
  it("generates the exact expected TypeSpec for the shipped example (public Order Placed/Open Orders)", () => {
    const src = readFileSync(EXAMPLE_PATH, "utf8");
    const path = "examples/order-fulfillment/order-fulfillment.em";
    const { text } = generate(src, path);
    const sha = createHash("sha256").update(src, "utf8").digest("hex");

    expect(text).toBe(`// GENERATED by \`em typespec\` (1.0) — EXPERIMENTAL / POC (MIL-159).
// Source: ${path} (sha256 ${sha})
// Scope: \`public\` events/views (docs/dsl.md "Integration surface"), plus every command in
// a slice that declares at least one of them. \`tag\`/\`renamed from\`/\`assigned\` are recorded
// as doc comments only — see docs/cli.md's "em typespec" section for the full mapping.
// Do not edit by hand — regenerate with \`em typespec ${path}\`.

namespace OrderFulfillment {
  model LineItem {
    sku: string;
    quantity: int32;
    unitPrice: decimal;
  }

  model OrderPlaced {
    /** system-assigned — not supplied by the triggering command */
    orderId: unknown;
    customerId: unknown;
    total: decimal;
    /** system-assigned — not supplied by the triggering command */
    placedAt: utcDateTime;
  }

  model OpenOrders {
    orderId: unknown;
    total: decimal;
    status: unknown;
  }

  interface Views {
    op getOpenOrders(): OpenOrders;
  }

  interface Commands {
    op placeOrder(customerId: unknown, items: LineItem[], total: decimal): void;
  }
}`);
  });
});

// ---- Optional compile-verification (MIL-159's "skip-if-absent" instruction) --------------
//
// `@typespec/compiler` is a devDependency (never shipped — src/emit/typespec.ts emits source
// text directly and depends on nothing beyond the standard library). This block actually
// compiles what the generator produces, catching a syntax mistake this file's own string
// assertions above couldn't — but it degrades to a skip, not a failure, if the package (or its
// CLI binary) isn't present, exactly as the ticket asked for.
const TSP_BIN = join(ROOT, "node_modules", ".bin", "tsp");
const TSP_AVAILABLE = existsSync(TSP_BIN);

function tspCompile(text: string): { status: number | null; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "em-typespec-"));
  try {
    const file = join(dir, "main.tsp");
    writeFileSync(file, text);
    const res = spawnSync(process.execPath, [TSP_BIN, "compile", file, "--no-emit"], {
      encoding: "utf8",
    });
    return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!TSP_AVAILABLE)("compiles with @typespec/compiler", () => {
  it("the real order-fulfillment example's generated contract compiles", () => {
    const src = readFileSync(EXAMPLE_PATH, "utf8");
    const { text } = generate(src, "examples/order-fulfillment/order-fulfillment.em");
    const { status, stdout, stderr } = tspCompile(text);
    expect(status, `tsp compile failed:\n${stdout}\n${stderr}`).toBe(0);
  });

  it("a fixture exercising named types, tags, renames, assigned, and an unmapped type compiles", () => {
    const { text } = generate(`
type Money2 {
  cents: long
  currency: string
}
slice "Do Widget Thing" {
  ui Admin Screen @Admin
  command Do Widget Thing renamed from "Old Widget Thing" {
    widgetId: UUID
    amount: Money2
  }
  event Widget Thinged @Widget public renamed from "Widget Old Thinged" {
    widgetId: UUID tag
    amount: Money2
    createdAt: Instant assigned
    unmappedField: SomeWeirdCustomType
  }
  tag widgetComposite from widgetId, amount
}
slice "View Widgets" {
  view Widget List public from "Widget Thinged" {
    widgetId: UUID
    amount: Money2
  }
}
`);
    const { status, stdout, stderr } = tspCompile(text);
    expect(status, `tsp compile failed:\n${stdout}\n${stderr}`).toBe(0);
  });

  it("the empty-scope (no public elements) output compiles", () => {
    const { text } = generate(`slice "S" {\n  command Do Thing\n}`);
    const { status, stdout, stderr } = tspCompile(text);
    expect(status, `tsp compile failed:\n${stdout}\n${stderr}`).toBe(0);
  });
});
