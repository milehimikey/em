// SPDX-License-Identifier: MIT
// `em api surface --json` (GH #448): the model's public commands/events/views plus reachable
// declared types as a versioned JSON document for companion tools — built on the same
// `publicSurfaceOf`/`resolvePublicType` `em api generate`/`em api check` already share. Covers
// the serializer (buildApiSurfaceReport/buildApiSurfaceJson) directly, the CLI (text + --json,
// refusal), determinism, and a repeated-view model contributing one entry. Follows
// test/api.test.ts's conventions (the `generate`/`em`/`tmpMultiModelRepo`-style helpers) since
// there is no dedicated apiCheckJson.test.ts to mirror — apiCheckJson's own JSON shape is
// covered inline in test/api.test.ts the same way this file covers api surface.
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTemp } from "./helpers/rmTemp.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildApiSurfaceReport, runApiSurface } from "../src/cli/api.js";
import { buildApiSurfaceJson, API_SURFACE_SCHEMA_VERSION } from "../src/emit/apiSurfaceJson.js";

// The CLI blocks spawn the real `em` via tsx (~1 s each), same budget as test/api.test.ts.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const report = (src: string, path = "model.em") => {
  const { model, refs, diagnostics } = compile(src);
  return buildApiSurfaceReport(model, refs, diagnostics, src, path);
};

describe("buildApiSurfaceReport: shape", () => {
  it("carries file, modelKey, and empty arrays for a model with no public element", () => {
    const r = report(`slice "Internal" {\n  command Do Thing\n  event Thing Done @Domain\n}\n`, "m.em");
    expect(r).toEqual({ file: "m.em", modelKey: "m", commands: [], events: [], views: [], types: [], scalars: [], enums: [] });
  });

  it("names the model's own key", () => {
    const r = report(`model "Shop"\nslice "S" {\n  command Buy public { sku: string }\n  event Bought @D\n}\n`);
    expect(r.modelKey).toBe("shop");
  });

  it("collects public commands/events/views into their own arrays, each with name/slug/fields/invariants", () => {
    const r = report(`
slice "S" {
  command Do Thing public { a: string }
  event Thing Done @D public { a: string }
}
slice "T" {
  view Things public from "Thing Done" { a: string }
}
`);
    expect(r.commands).toEqual([
      {
        name: "Do Thing",
        slug: "do-thing",
        fields: [{ name: "a", type: { kind: "scalar", scalar: "string", base: null, tsType: "string", array: false }, optional: false, tag: false, assigned: false, renamedFrom: null }],
        invariants: null,
      },
    ]);
    expect(r.events[0]).toMatchObject({ name: "Thing Done", slug: "thing-done" });
    expect(r.views[0]).toMatchObject({ name: "Things", slug: "things" });
  });

  it("omits a non-public element entirely", () => {
    const r = report(`slice "S" {\n  command Do public\n  command Other\n  event Done @D\n}\n`);
    expect(r.commands.map((c) => c.name)).toEqual(["Do"]);
  });
});

describe("field type resolution (R7, shared with em api generate/check)", () => {
  it("resolves every table scalar, bare and array", () => {
    const r = report(`
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: string
    b: int
    c: long
    d: decimal
    e: boolean
    f: uuid
    g: date
    h: datetime
    i: duration
    j: bytes
    k: string[]
  }
}
`);
    const byName = new Map(r.events[0].fields.map((f) => [f.name, f.type]));
    expect(byName.get("a")).toEqual({ kind: "scalar", scalar: "string", base: null, tsType: "string", array: false });
    expect(byName.get("b")).toEqual({ kind: "scalar", scalar: "int", base: null, tsType: "int32", array: false });
    expect(byName.get("c")).toEqual({ kind: "scalar", scalar: "long", base: null, tsType: "int64", array: false });
    expect(byName.get("d")).toEqual({ kind: "scalar", scalar: "decimal", base: null, tsType: "decimal", array: false });
    expect(byName.get("e")).toEqual({ kind: "scalar", scalar: "boolean", base: null, tsType: "boolean", array: false });
    expect(byName.get("f")).toEqual({ kind: "scalar", scalar: "uuid", base: null, tsType: "Uuid", array: false });
    expect(byName.get("g")).toEqual({ kind: "scalar", scalar: "date", base: null, tsType: "plainDate", array: false });
    expect(byName.get("h")).toEqual({ kind: "scalar", scalar: "datetime", base: null, tsType: "utcDateTime", array: false });
    expect(byName.get("i")).toEqual({ kind: "scalar", scalar: "duration", base: null, tsType: "duration", array: false });
    expect(byName.get("j")).toEqual({ kind: "scalar", scalar: "bytes", base: null, tsType: "bytes", array: false });
    expect(byName.get("k")).toEqual({ kind: "scalar", scalar: "string", base: null, tsType: "string", array: true });
  });

  it("resolves a declared type (bare and array) as kind declared, scalar null", () => {
    const r = report(`
type Money2 { cents: long }
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: Money2
    b: Money2[]
  }
}
`);
    const byName = new Map(r.events[0].fields.map((f) => [f.name, f.type]));
    expect(byName.get("a")).toEqual({ kind: "declared", scalar: null, base: null, tsType: "Money2", array: false });
    expect(byName.get("b")).toEqual({ kind: "declared", scalar: null, base: null, tsType: "Money2", array: true });
  });

  it("resolves a declared identity scalar (bare and array) as kind scalar-alias, carrying the base it extends (GH #477)", () => {
    const r = report(`
scalar OrderId: uuid
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: OrderId
    b: OrderId[]
  }
}
`);
    const byName = new Map(r.events[0].fields.map((f) => [f.name, f.type]));
    expect(byName.get("a")).toEqual({ kind: "scalar-alias", scalar: null, base: "uuid", tsType: "OrderId", array: false });
    expect(byName.get("b")).toEqual({ kind: "scalar-alias", scalar: null, base: "uuid", tsType: "OrderId", array: true });
  });

  it("resolves a declared enum (bare and array) as kind enum, tsType the enum's own name (GH #478)", () => {
    const r = report(`
enum OrderStatus { placed, shipped }
slice "S" {
  command Do Thing
  event Thing Done @Domain public {
    a: OrderStatus
    b: OrderStatus[]
  }
}
`);
    const byName = new Map(r.events[0].fields.map((f) => [f.name, f.type]));
    expect(byName.get("a")).toEqual({ kind: "enum", scalar: null, base: null, tsType: "OrderStatus", array: false });
    expect(byName.get("b")).toEqual({ kind: "enum", scalar: null, base: null, tsType: "OrderStatus", array: true });
  });

  it("throws rather than falling back to unknown when handed an unvalidated model (same posture as em api generate)", () => {
    expect(() => report(`slice "S" {\n  event Thing Done @Domain public { a: Money }\n}\n`)).toThrow(
      /has no public type/,
    );
  });
});

describe("optional / tag / assigned / renamedFrom / invariants carried through", () => {
  it("carries optional, tag, assigned, renamedFrom per field, and element invariants in declaration order", () => {
    const r = report(`
slice "S" {
  command Do Thing
  event Thing Done renamed from "Thing Was Done" @Domain public {
    a: uuid tag
    b: string renamed from "oldB"
    c: datetime assigned
    d?: text
  }
  invariant INV-DO-1 "a is set"
  invariant INV-DO-2
}
`);
    const ev = r.events[0];
    expect(ev.name).toBe("Thing Done");
    expect(ev.invariants).toEqual([{ id: "INV-DO-1", rule: "a is set" }, { id: "INV-DO-2", rule: null }]);
    const byName = new Map(ev.fields.map((f) => [f.name, f]));
    expect(byName.get("a")).toMatchObject({ tag: true, assigned: false, renamedFrom: null });
    expect(byName.get("b")).toMatchObject({ tag: false, renamedFrom: ["oldB"] });
    expect(byName.get("c")).toMatchObject({ assigned: true });
    expect(byName.get("d")).toMatchObject({ optional: true });
  });

  it("invariants is null on an element with none", () => {
    const r = report(`slice "S" {\n  command Do public\n  event Done @D\n}\n`);
    expect(r.commands[0].invariants).toBeNull();
  });

  it("an internal element's invariants never reach the surface", () => {
    const r = report(`
slice "S" {
  ui U
  command Internal { y: string }
  invariant INV-IN-1 "y is set"
  event Internal Done @D
}
`);
    expect(r.commands).toEqual([]);
  });
});

describe("reachable declared types (GH #448)", () => {
  it("lists only declared types reachable from a public element's fields, including transitively", () => {
    const r = report(`
type Used { x: string, nested: Nested }
type Nested { n: string }
type Unused { y: string }
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a: Used }
}
`);
    expect(r.types.map((t) => t.name).sort()).toEqual(["Nested", "Used"]);
    expect(r.types.find((t) => t.name === "Nested")?.fields).toEqual([
      { name: "n", type: { kind: "scalar", scalar: "string", base: null, tsType: "string", array: false }, optional: false, tag: false, assigned: false, renamedFrom: null },
    ]);
  });

  it("lists no types when nothing public references a declared type", () => {
    const r = report(`type Money2 { cents: long }\nslice "S" {\n  command Do public\n  event Done @D\n}\n`);
    expect(r.types).toEqual([]);
  });
});

describe("reachable declared scalars (GH #477)", () => {
  it("lists only identity scalars reachable from a public element's fields, in declaration order", () => {
    const r = report(`
scalar OrderId: uuid
scalar Sku: string
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a: OrderId }
}
`);
    expect(r.scalars).toEqual([{ name: "OrderId", slug: "orderid", base: "uuid" }]);
  });

  it("lists no scalars when nothing public references a declared scalar", () => {
    const r = report(`scalar OrderId: uuid\nslice "S" {\n  command Do public\n  event Done @D\n}\n`);
    expect(r.scalars).toEqual([]);
  });
});

describe("reachable declared enums (GH #478)", () => {
  it("lists only enums reachable from a public element's fields, in declaration order, with their members", () => {
    const r = report(`
enum OrderStatus { placed, shipped }
enum PaymentStatus { pending, paid }
slice "S" {
  command Do Thing
  event Thing Done @Domain public { a: OrderStatus }
}
`);
    expect(r.enums).toEqual([{ name: "OrderStatus", slug: "orderstatus", members: ["placed", "shipped"] }]);
  });

  it("lists no enums when nothing public references a declared enum", () => {
    const r = report(`enum OrderStatus { placed, shipped }\nslice "S" {\n  command Do public\n  event Done @D\n}\n`);
    expect(r.enums).toEqual([]);
  });
});

describe("repeated view (`again`): contributes one entry", () => {
  it("a view declared `again` is folded into its first public instance, same as em api generate", () => {
    const r = report(`
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
    expect(r.views.length).toBe(1);
    expect(r.views[0].name).toBe("Board");
  });
});

describe("buildApiSurfaceJson: envelope + determinism", () => {
  it("wraps the report with apiSurfaceSchemaVersion/generator, in a fixed key order", () => {
    const r = report(`model "Shop"\nslice "S" {\n  command Buy public { sku: string }\n  event Bought @D\n}\n`);
    const text = buildApiSurfaceJson(r);
    const doc = JSON.parse(text);
    expect(Object.keys(doc)).toEqual(["apiSurfaceSchemaVersion", "generator", "file", "modelKey", "commands", "events", "views", "types", "scalars", "enums"]);
    expect(doc.apiSurfaceSchemaVersion).toBe(API_SURFACE_SCHEMA_VERSION);
    expect(doc.generator.name).toBe("@milehimikey/em");
    expect(doc.modelKey).toBe("shop");
  });

  it("is deterministic: two builds from the same source are byte-identical", () => {
    const src = `model "Shop"\ntype Money2 { cents: long }\nslice "S" {\n  command Buy public { sku: string, price: Money2 }\n  event Bought @D public { sku: string, price: Money2 }\n}\n`;
    expect(buildApiSurfaceJson(report(src))).toBe(buildApiSurfaceJson(report(src)));
  });
});

// ---- CLI: `em api surface` --------------------------------------------------------------

describe("em api surface (CLI)", () => {
  it("text listing names each command/event/view/type with its field count", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-api-surface-"));
    try {
      writeFileSync(join(dir, "shop.em"), `model "Shop"\nslice "S" {\n  command Buy public { sku: string }\n  event Bought @D\n}\n`);
      const r = em(["api", "surface", "shop.em"], dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("model shop (shop.em)\ncommands:\n  buy (1 field)\n");
    } finally {
      rmTemp(dir);
    }
  });

  it("--json prints the same document buildApiSurfaceJson would, file as given on the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-api-surface-"));
    try {
      writeFileSync(join(dir, "shop.em"), `model "Shop"\nslice "S" {\n  command Buy public { sku: string }\n  event Bought @D\n}\n`);
      const r = em(["api", "surface", "shop.em", "--json"], dir);
      expect(r.status).toBe(0);
      const outcome = runApiSurface(join(dir, "shop.em"));
      if (!outcome.ok) throw new Error("expected ok");
      const expected = buildApiSurfaceJson({ ...outcome.report, file: "shop.em" }) + "\n";
      expect(r.stdout).toBe(expected);
    } finally {
      rmTemp(dir);
    }
  });

  it("prints (no public surface) when the model declares nothing public", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-api-surface-"));
    try {
      writeFileSync(join(dir, "shop.em"), `slice "S" {\n  command Buy { sku: string }\n  event Bought @D\n}\n`);
      const r = em(["api", "surface", "shop.em"], dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("(no public surface)");
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses (exit 1) on a model with a public-field-type-unresolved error, writing nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-api-surface-"));
    try {
      writeFileSync(join(dir, "shop.em"), `slice "S" {\n  command Buy public { sku: Sku }\n  event Bought @D\n}\n`);
      const r = em(["api", "surface", "shop.em"], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('public command "Buy" field "sku" has type "Sku", which is not a public type');
      expect(r.stderr).toContain("em api surface: not generating — fix the errors above");
      expect(r.stdout).toBe("");
    } finally {
      rmTemp(dir);
    }
  });

  it("the golden examples/order-fulfillment model's surface is deterministic across two CLI runs", () => {
    const file = join(ROOT, "examples/order-fulfillment/order-fulfillment.em");
    const a = em(["api", "surface", file, "--json"], ROOT);
    const b = em(["api", "surface", file, "--json"], ROOT);
    expect(a.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const doc = JSON.parse(a.stdout);
    expect(doc.events.map((e: { name: string }) => e.name)).toContain("Order Placed");
    expect(doc.views.map((v: { name: string }) => v.name)).toContain("Open Orders");
  });
});
