// SPDX-License-Identifier: MIT
// GH #527: the code map — its parser (src/codemap/codeMap.ts), place derivation
// (src/codemap/places.ts), the `em validate` rules (src/codemap/codeMapValidate.ts) and the
// manifest lookup they read repo ids through (src/system/systemRepos.ts).
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { rmTemp } from "./helpers/rmTemp.js";
import { formatPlace, normalizeRoot, parseCodeMap, CodeMap } from "../src/codemap/codeMap.js";
import { derivePlaces, slicePlaces } from "../src/codemap/places.js";
import { loadCodeMap, validateCodeMap } from "../src/codemap/codeMapValidate.js";
import { findSystemManifest, loadDeclaredRepos } from "../src/system/systemRepos.js";

const MODEL = `model "Shop"
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Orders
}
slice "Orders To Charge" {
  view Orders To Charge from "Order Placed"
  ui Charge Queue @Staff
}
slice "Take Payment" {
  processor Charge Card from "Orders To Charge"
  command Take Payment
  event Payment Taken @Payments
}
slice "Charged Orders" {
  view Orders To Charge again from "Payment Taken"
  ui Payments Board @Staff
}
slice "Receipts" {
  view Receipts from "Order Placed", "Payment Taken"
  ui Receipt List @Customer
}
slice "Import Refund" {
  translation Refund Webhook
  command Record Refund
  event Refund Recorded @Payments
}
`;

const MAP = `codeMapSchemaVersion: "1.0"
default: {repo: orders-svc, root: services/orders}
personas:
  Customer: {repo: storefront-web, root: ./src/checkout/}
contexts:
  Payments: {repo: payments-svc}
`;

function mapOf(text: string): CodeMap {
  const r = parseCodeMap(text);
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("\n"));
  return r.map;
}

describe("parseCodeMap", () => {
  it("reads default, personas, contexts and elements, normalizing roots and defaulting repo to self", () => {
    const map = mapOf(
      MAP + `elements:\n  place-order/ui.checkout: {repo: mobile-app, root: app/checkout}\n  receipts/view.receipts: {root: reports}\nmodel: shop.em\n`,
    );
    expect(map.model).toBe("shop.em");
    expect(map.default).toEqual({ place: { repo: "orders-svc", root: "services/orders" }, line: 2 });
    expect(map.personas).toEqual([{ key: "Customer", place: { repo: "storefront-web", root: "src/checkout" }, line: 4 }]);
    expect(map.contexts).toEqual([{ key: "Payments", place: { repo: "payments-svc", root: "" }, line: 6 }]);
    expect(map.elements).toEqual([
      { key: "place-order/ui.checkout", place: { repo: "mobile-app", root: "app/checkout" }, line: 8 },
      { key: "receipts/view.receipts", place: { repo: "self", root: "reports" }, line: 9 },
    ]);
  });

  it.each([
    [`default: {repo: a}\n`, "missing or non-string `codeMapSchemaVersion`"],
    [`codeMapSchemaVersion: "2.0"\ndefault: {repo: a}\n`, 'unsupported codeMapSchemaVersion "2.0"'],
    [`codeMapSchemaVersion: "1.0"\n`, "code map places nothing"],
    [`codeMapSchemaVersion: "1.0"\npersona:\n  Customer: {repo: a}\n`, 'unknown top-level key "persona"'],
    [`codeMapSchemaVersion: "1.0"\nrepos:\n  a: {remote: x}\ndefault: {repo: a}\n`, 'unknown top-level key "repos"'],
    [`codeMapSchemaVersion: "1.0"\ndefault: {}\n`, "`default` must name a `repo`, a `root`, or both"],
    [`codeMapSchemaVersion: "1.0"\ndefault: orders-svc\n`, "`default` must be a mapping"],
    [`codeMapSchemaVersion: "1.0"\ndefault: {repo: "two words"}\n`, "`default`: `repo` must be a repo id"],
    [`codeMapSchemaVersion: "1.0"\ndefault: {repo: a, root: ../elsewhere}\n`, "`root` must be a path relative to the repository root"],
    [`codeMapSchemaVersion: "1.0"\ndefault: {repo: a, root: /abs}\n`, "`root` must be a path relative to the repository root"],
    [`codeMapSchemaVersion: "1.0"\ndefault: {repo: a, path: x}\n`, '`default`: unknown key "path"'],
    [`codeMapSchemaVersion: "1.0"\ncontexts: [Payments]\n`, "`contexts` must be a mapping of context name"],
    [`codeMapSchemaVersion: "1.0"\ndefault: {repo: a}\nmodel: ../shop.em\n`, "`model` must be the model file's name"],
    [`codeMapSchemaVersion: "1.0"\ndefault: [\n`, "YAML parse error"],
  ])("refuses %j", (text, message) => {
    const r = parseCodeMap(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.message).join("\n")).toContain(message);
  });

  it("normalizeRoot / formatPlace", () => {
    expect(normalizeRoot("./a//b/")).toBe("a/b");
    expect(normalizeRoot(".")).toBe("");
    expect(normalizeRoot("a/../b")).toBeNull();
    expect(normalizeRoot("C:\\x")).toBeNull();
    expect(formatPlace({ repo: "self", root: "" })).toBe("self");
    expect(formatPlace({ repo: "web", root: "src" })).toBe("web:src");
  });
});

describe("derivePlaces", () => {
  const { model, refs } = compile(MODEL);
  const place = (map: CodeMap, ref: string, fallback = [] as { repo: string; root: string }[]) => {
    const p = derivePlaces(model, refs, map, fallback).byRef.get(ref)!;
    return p.places.length > 0 ? `${p.places.map(formatPlace).join(" + ")} (${p.placedBy})` : `unplaced: ${p.unplacedReason}`;
  };
  const map = mapOf(MAP);

  it("routes a ui by persona, and an unmapped persona to the default", () => {
    expect(place(map, "place-order/ui.checkout")).toBe("storefront-web:src/checkout (persona)");
    expect(place(map, "orders-to-charge/ui.charge-queue")).toBe("orders-svc:services/orders (default)");
  });

  it("routes an event by its own context, and a command by the events of its slice", () => {
    expect(place(map, "take-payment/event.payment-taken")).toBe("payments-svc (context)");
    expect(place(map, "take-payment/command.take-payment")).toBe("payments-svc (context)");
    expect(place(map, "place-order/event.order-placed")).toBe("orders-svc:services/orders (default)");
    expect(place(map, "place-order/command.place-order")).toBe("orders-svc:services/orders (default)");
  });

  it("routes a view by the events it reads, and a later instance with its first", () => {
    expect(place(map, "orders-to-charge/view.orders-to-charge")).toBe("orders-svc:services/orders (default)");
    // The `again` instance reads a Payments event, but it is the same read model.
    expect(place(map, "charged-orders/view.orders-to-charge")).toBe("orders-svc:services/orders (default)");
  });

  it("routes a reaction with its trigger, so an Automation slice can span two repos", () => {
    expect(place(map, "take-payment/processor.charge-card")).toBe("orders-svc:services/orders (reads)");
    const takePayment = model.slices.findIndex((s) => s.name === "Take Payment");
    expect(slicePlaces(model, refs, derivePlaces(model, refs, map), takePayment).map(formatPlace)).toEqual(["orders-svc:services/orders", "payments-svc"]);
  });

  it("routes a reaction fed from outside the model by the events of its slice", () => {
    expect(place(map, "import-refund/translation.refund-webhook")).toBe("payments-svc (context)");
  });

  it("leaves an element unplaced when its contexts route to different places, and an override settles it", () => {
    expect(place(map, "receipts/view.receipts")).toBe(
      "unplaced: the events it reads sit in contexts that route to different places (Orders -> orders-svc:services/orders; Payments -> payments-svc)",
    );
    const fixed = mapOf(MAP + `elements:\n  receipts/view.receipts: {repo: storefront-web, root: src/receipts}\n`);
    expect(place(fixed, "receipts/view.receipts")).toBe("storefront-web:src/receipts (element)");
  });

  it("a reaction follows the PLACE of what it reads: an override on the view moves the reaction too", () => {
    const m = mapOf(MAP + `elements:\n  orders-to-charge/view.orders-to-charge: {repo: payments-svc, root: queue}\n`);
    expect(place(m, "take-payment/processor.charge-card")).toBe("payments-svc:queue (reads)");
  });

  it("a reaction reading an unplaced view is unplaced for that reason, and an override on the view settles both", () => {
    const src = MODEL + `slice "Mail Receipt" {\n  processor Receipt Mailer from "Receipts"\n  command Mail Receipt\n  event Receipt Mailed @Orders\n}\n`;
    const c = compile(src);
    const at = (m: CodeMap, ref: string) => {
      const p = derivePlaces(c.model, c.refs, m).byRef.get(ref)!;
      return p.places.length > 0 ? `${p.places.map(formatPlace).join(" + ")} (${p.placedBy})` : `unplaced: ${p.unplacedReason}`;
    };
    expect(at(map, "mail-receipt/processor.receipt-mailer")).toBe('unplaced: what it reads has no place (view "Receipts" -> no place)');
    const fixed = mapOf(MAP + `elements:\n  receipts/view.receipts: {repo: storefront-web, root: src/receipts}\n`);
    expect(at(fixed, "mail-receipt/processor.receipt-mailer")).toBe("storefront-web:src/receipts (reads)");
  });

  it("a view named by a storyline written later but first on the timeline routes its readers with it", () => {
    // `again` instances resolve through logicalId; the reaction must use the same first instance.
    const c = compile(MODEL);
    const again = c.model.elements.find((e) => e.kind === "view" && e.again === true)!;
    const first = c.model.byId.get(again.logicalId)!;
    expect(first.again).not.toBe(true);
    const m = mapOf(MAP + `elements:\n  ${c.refs.refById.get(first.id)}: {repo: payments-svc, root: q}\n`);
    expect(place(m, c.refs.refById.get(again.id)!)).toBe("payments-svc:q (element)");
    expect(place(m, "take-payment/processor.charge-card")).toBe("payments-svc:q (reads)");
  });

  it("an override on a first instance carries to its later instances", () => {
    const m = mapOf(MAP + `elements:\n  orders-to-charge/view.orders-to-charge: {repo: payments-svc, root: queue}\n`);
    expect(place(m, "charged-orders/view.orders-to-charge")).toBe("payments-svc:queue (element)");
  });

  it("with no default: the caller's fallback places what no rule does; without one the element is unplaced", () => {
    const noDefault = mapOf(`codeMapSchemaVersion: "1.0"\ncontexts:\n  Payments: {repo: payments-svc}\n`);
    expect(place(noDefault, "place-order/ui.checkout")).toBe('unplaced: no `personas:` entry for "Customer", and the code map has no `default:`');
    expect(place(noDefault, "place-order/event.order-placed")).toBe("unplaced: no `contexts:` entry covers it, and the code map has no `default:`");
    const fallback = [{ repo: "self", root: "src/a" }, { repo: "self", root: "src/b" }, { repo: "self", root: "src/a" }];
    expect(place(noDefault, "place-order/ui.checkout", fallback)).toBe("self:src/a + self:src/b (code-roots)");
    expect(place(noDefault, "take-payment/event.payment-taken", fallback)).toBe("payments-svc (context)");
  });

  it("two places in one repo with different roots are two places", () => {
    const m = mapOf(`codeMapSchemaVersion: "1.0"\ndefault: {root: services/orders}\ncontexts:\n  Payments: {root: services/payments}\n`);
    const takePayment = model.slices.findIndex((s) => s.name === "Take Payment");
    expect(slicePlaces(model, refs, derivePlaces(model, refs, m), takePayment)).toEqual([
      { repo: "self", root: "services/orders" },
      { repo: "self", root: "services/payments" },
    ]);
  });
});

describe("validateCodeMap and the manifest lookup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmTemp(dirs.pop()!);
  });
  /** A repo root (marked by `.git`) holding `models/shop/shop.em`; returns the model path. */
  const project = (files: Record<string, string>): { root: string; modelFile: string } => {
    const root = mkdtempSync(join(tmpdir(), "em-code-map-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "models", "shop"), { recursive: true });
    writeFileSync(join(root, "models", "shop", "shop.em"), MODEL);
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
    return { root, modelFile: join(root, "models", "shop", "shop.em") };
  };
  const SYSTEM = `systemSchemaVersion: "2.1"\nrepos:\n  storefront-web: {remote: "git@github.com:acme/storefront-web.git"}\n  orders-svc: {remote: "git@github.com:acme/orders-svc.git"}\n  payments-svc: {remote: "git@github.com:acme/payments-svc.git"}\nmodels:\n  shop: {source: models/shop/shop.em}\n`;
  const OVERRIDE = `elements:\n  receipts/view.receipts: {repo: storefront-web}\n`;
  const { model, refs } = compile(MODEL);
  const codes = (modelFile: string) => validateCodeMap(model, refs, modelFile).map((d) => d.code);

  it("no code map: no diagnostics", () => {
    const { modelFile } = project({ "system.yaml": SYSTEM });
    expect(validateCodeMap(model, refs, modelFile)).toEqual([]);
    expect(loadCodeMap(modelFile)).toEqual({ kind: "none" });
  });

  it("a complete map against declared repos is clean", () => {
    const { modelFile } = project({ "system.yaml": SYSTEM, "models/shop/code-map.yaml": MAP + OVERRIDE });
    expect(validateCodeMap(model, refs, modelFile)).toEqual([]);
  });

  it("finds the manifest above the model, and stops at the repository root", () => {
    const { root, modelFile } = project({ "system.yaml": SYSTEM });
    expect(findSystemManifest(join(root, "models", "shop"))).toBe(join(root, "system.yaml"));
    const declared = loadDeclaredRepos(join(root, "models", "shop"));
    expect(declared.kind === "ok" && declared.repos.map((r) => r.id)).toEqual(["storefront-web", "orders-svc", "payments-svc"]);
    // A manifest above the repository root does not govern the model.
    const outer = mkdtempSync(join(tmpdir(), "em-code-map-outer-"));
    dirs.push(outer);
    writeFileSync(join(outer, "system.yaml"), SYSTEM);
    mkdirSync(join(outer, "repo", ".git"), { recursive: true });
    mkdirSync(join(outer, "repo", "m"));
    expect(findSystemManifest(join(outer, "repo", "m"))).toBeNull();
    expect(modelFile).toContain("shop.em");
  });

  it("code-map-invalid: a shape problem, with the line in code-map.yaml", () => {
    const { modelFile } = project({ "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\ndefault: {repo: a, path: x}\n` });
    const diags = validateCodeMap(model, refs, modelFile);
    expect(diags).toEqual([
      { severity: "error", code: "code-map-invalid", message: 'code-map.yaml: `default`: unknown key "path" — expected repo, root', line: 2, file: "code-map.yaml" },
    ]);
  });

  it("code-map-unknown-repo: with no system.yaml, a repo other than self is undeclared; self needs none", () => {
    const { modelFile } = project({ "models/shop/code-map.yaml": MAP + OVERRIDE });
    const diags = validateCodeMap(model, refs, modelFile);
    expect(diags.map((d) => d.code)).toEqual(["code-map-unknown-repo", "code-map-unknown-repo", "code-map-unknown-repo"]);
    expect(diags[0].message).toContain('unknown repo id "orders-svc" — no system.yaml governs this model');
    expect(diags[0]).toMatchObject({ line: 2, file: "code-map.yaml" });
    const selfOnly = project({ "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\ndefault: {root: src}\n` });
    expect(validateCodeMap(model, refs, selfOnly.modelFile)).toEqual([]);
  });

  it("code-map-unknown-repo: names the manifest relative to the model and what it declares, once per id", () => {
    const { modelFile } = project({
      "system.yaml": SYSTEM,
      "models/shop/code-map.yaml": MAP + OVERRIDE + `  place-order/ui.checkout: {repo: mobile-app}\n  receipts/ui.receipt-list: {repo: mobile-app}\n`,
    });
    const diags = validateCodeMap(model, refs, modelFile);
    expect(diags.map((d) => d.code)).toEqual(["code-map-unknown-repo"]);
    expect(diags[0].message).toBe('code-map.yaml: unknown repo id "mobile-app" — ../../system.yaml declares: storefront-web, orders-svc, payments-svc');
  });

  it("code-map-unknown-repo: a 2.0 manifest declares none, and an invalid one cannot be used", () => {
    const v20 = project({ "system.yaml": `systemSchemaVersion: "2.0"\nmodels:\n  shop: {source: models/shop/shop.em}\n`, "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders-svc}\n` });
    expect(validateCodeMap(model, refs, v20.modelFile)[0].message).toContain("../../system.yaml declares no `repos:`");
    const bad = project({ "system.yaml": `systemSchemaVersion: "9.9"\nmodels: {}\n`, "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders-svc}\n` });
    expect(validateCodeMap(model, refs, bad.modelFile)[0].message).toContain("../../system.yaml cannot be used (");
  });

  it("code-map-unknown-persona / -context / -element", () => {
    const { modelFile } = project({
      "system.yaml": SYSTEM,
      "models/shop/code-map.yaml":
        MAP.replace("Customer:", "customer:").replace("Payments:", "Billing:") + `elements:\n  place-order/ui.nope: {repo: storefront-web}\n`,
    });
    const diags = validateCodeMap(model, refs, modelFile);
    expect(diags.map((d) => d.code)).toEqual(["code-map-unknown-persona", "code-map-unknown-context", "code-map-unknown-element"]);
    expect(diags[0].message).toBe('code-map.yaml: persona "customer" is not in the model (did you mean "Customer"?)');
    expect(diags[1].message).toBe('code-map.yaml: context "Billing" is not in the model (the model has: Orders, Payments)');
    expect(diags[2].line).toBe(8);
  });

  it("code-map-element-unplaced: points at the element in the model, with its ref", () => {
    const { modelFile } = project({ "system.yaml": SYSTEM, "models/shop/code-map.yaml": MAP });
    const diags = validateCodeMap(model, refs, modelFile);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "error", code: "code-map-element-unplaced", refs: ["receipts/view.receipts"] });
    expect(diags[0].file).toBeUndefined();
    expect(diags[0].message).toContain("add `receipts/view.receipts` under `elements:` in code-map.yaml");
    // A caller's fallback does not settle an ambiguity, but it does place what merely had no rule.
    const noDefault = project({ "system.yaml": SYSTEM, "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\npersonas:\n  Customer: {repo: storefront-web}\n` });
    expect(codes(noDefault.modelFile).every((c) => c === "code-map-element-unplaced")).toBe(true);
    expect(validateCodeMap(model, refs, noDefault.modelFile, [{ repo: "self", root: "src" }])).toEqual([]);
  });

  it("a malformed map that names another model in the directory is still not reported against this one", () => {
    const { root, modelFile } = project({ "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\nmodel: other.em\ndefault: {path: x}\n` });
    writeFileSync(join(root, "models", "shop", "other.em"), MODEL);
    expect(validateCodeMap(model, refs, modelFile)).toEqual([]);
  });

  it("model: naming no file in the directory is an error, not a silently ignored map", () => {
    const { modelFile } = project({ "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\nmodel: Shop.em\ndefault: {root: src}\n` });
    const diags = validateCodeMap(model, refs, modelFile);
    expect(diags).toEqual([
      { severity: "error", code: "code-map-invalid", message: 'code-map.yaml: `model: Shop.em` names no file in this directory — it must be the model file\'s exact name (this is "shop.em")', line: 2, file: "code-map.yaml" },
    ]);
  });

  it("the default hint is given only when a default would help", () => {
    const { modelFile } = project({ "system.yaml": SYSTEM, "models/shop/code-map.yaml": MAP });
    const msg = validateCodeMap(model, refs, modelFile)[0].message;
    expect(msg).toContain("add `receipts/view.receipts` under `elements:` in code-map.yaml");
    expect(msg).not.toContain("give the map a `default:`");
  });

  it("a map whose model: names another file is not this model's", () => {
    const { root, modelFile } = project({ "models/shop/code-map.yaml": `codeMapSchemaVersion: "1.0"\nmodel: other.em\ndefault: {repo: nowhere}\n` });
    writeFileSync(join(root, "models", "shop", "other.em"), MODEL);
    expect(validateCodeMap(model, refs, modelFile)).toEqual([]);
  });
});

describe("em validate (CLI) with a code map", () => {
  it("reports code-map rules beside the model's own, in text and --json, and exits 1", async () => {
    const { spawnSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
    const em = (args: string[], cwd: string) =>
      spawnSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
    const root = mkdtempSync(join(tmpdir(), "em-code-map-cli-"));
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, "shop.em"), MODEL);
      const clean = em(["validate", "shop.em"], root);
      expect(clean.status).toBe(0);
      writeFileSync(join(root, "code-map.yaml"), `codeMapSchemaVersion: "1.0"\ndefault: {repo: orders-svc}\n`);
      const text = em(["validate", "shop.em"], root);
      expect(text.status).toBe(1);
      expect(text.stderr + text.stdout).toContain('code-map.yaml:2 code-map.yaml: unknown repo id "orders-svc"');
      const json = JSON.parse(em(["validate", "shop.em", "--json"], root).stdout);
      // `--json` diagnostics carry no `file` key (true of every em diagnostic), so the message
      // is what names the file a code-map line counts in.
      const codeMapDiags = json.diagnostics.filter((d: { code: string }) => d.code.startsWith("code-map-"));
      expect(codeMapDiags).toEqual([
        expect.objectContaining({ code: "code-map-unknown-repo", severity: "error", line: 2, usageCategory: "code map unknown repo" }),
      ]);
      expect(codeMapDiags[0].message.startsWith("code-map.yaml: ")).toBe(true);
      expect(json.ok).toBe(false);
    } finally {
      rmTemp(root);
    }
  }, 30_000);
});
