// SPDX-License-Identifier: MIT
// Unit coverage for `em system` (MIL-194): the manifest parser (src/system/manifest.ts), the
// export-only verifier (src/system/verify.ts) — one test per diagnostic code, the bare-slice
// `to` resolution, the "externally fed" computation — the fs loader's `.json` source path
// (src/cli/systemInputs.ts), and determinism of the --json document.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { buildExportDoc } from "../src/emit/json.js";
import { parseManifest, SystemManifest, SYSTEM_MANIFEST_SCHEMA_VERSION } from "../src/system/manifest.js";
import { verifySystem, SystemExportDoc, SystemModelInput } from "../src/system/verify.js";
import { loadSystem, readExportDoc } from "../src/cli/systemInputs.js";
import { buildSystemJson, SYSTEM_SCHEMA_VERSION } from "../src/emit/systemJson.js";

// ---- fixtures: two models that form one real seam ----

const CHECKOUT = `model "Checkout"

persona Customer
context Order

slice "Place" {
  ui Screen @Customer
  command Place Order
  event Order Placed @Order public
}

slice "Open Orders" {
  view Open Orders public from "Order Placed"
  ui List @Customer
}
`;

const FULFILLMENT = `model "Fulfillment"

persona Warehouse
context Order

slice "Intake" {
  translation Order Received
  command Accept Order
  event Order Accepted @Order
}

slice "To Ship" {
  view To Ship from "Order Accepted"
  ui Board @Warehouse
}
`;

/** Compile `.em` text into exactly the export-document slice the verifier reads — the same
 *  `compile()` + `buildExportDoc()` path src/cli/systemInputs.ts takes for a `.em` source. */
function exportOf(text: string, file = "model.em"): SystemExportDoc {
  const { model, refs, diagnostics } = compile(text);
  const { doc } = buildExportDoc(model, refs, diagnostics, text, file);
  return doc;
}

function modelInput(key: string, text: string, extra: Partial<SystemModelInput> = {}): SystemModelInput {
  const file = `${key}.em`;
  return { key, source: file, sourceKind: "em", owner: null, file, doc: exportOf(text, file), ...extra };
}

function manifestOf(models: SystemModelInput[], seams: Array<{ from: string; to: string; description?: string }>): SystemManifest {
  return {
    systemSchemaVersion: SYSTEM_MANIFEST_SCHEMA_VERSION,
    name: "Test System",
    models: models.map((m, i) => ({ key: m.key, source: m.source, owner: m.owner, line: 4 + i * 2 })),
    seams: seams.map((s, i) => ({ from: s.from, to: s.to, description: s.description ?? null, line: 20 + i * 3 })),
  };
}

const SEAM = { from: "checkout:place/event.order-placed", to: "fulfillment:intake/translation.order-received" };

describe("parseManifest", () => {
  it("parses the documented YAML shape", () => {
    const r = parseManifest(`systemSchemaVersion: "1.0"
name: Meridian Goods
models:
  checkout:
    source: models/checkout/checkout.em
    owner: Storefront team
  fulfillment:
    source: models/fulfillment/fulfillment.em
seams:
  - from: checkout:checkout/event.order-placed
    to: fulfillment:intake/translation.order-received
    description: optional free text
  - from: checkout:checkout/event.order-paid
    to: fulfillment:intake
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("Meridian Goods");
    expect(r.manifest.models).toEqual([
      { key: "checkout", source: "models/checkout/checkout.em", owner: "Storefront team", line: 4 },
      { key: "fulfillment", source: "models/fulfillment/fulfillment.em", owner: null, line: 7 },
    ]);
    expect(r.manifest.seams).toEqual([
      { from: "checkout:checkout/event.order-placed", to: "fulfillment:intake/translation.order-received", description: "optional free text", line: 10 },
      { from: "checkout:checkout/event.order-paid", to: "fulfillment:intake", description: null, line: 13 },
    ]);
  });

  it("accepts JSON (a YAML subset) and a manifest with no seams", () => {
    const r = parseManifest(JSON.stringify({ systemSchemaVersion: "1.0", models: { a: { source: "a.em" } } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBeNull();
      expect(r.manifest.seams).toEqual([]);
    }
  });

  it.each([
    ["missing version", `models:\n  a:\n    source: a.em\n`, /missing or non-string `systemSchemaVersion`/],
    ["YAML float version, not a string", `systemSchemaVersion: 1.0\nmodels:\n  a:\n    source: a.em\n`, /missing or non-string `systemSchemaVersion`/],
    ["unsupported version", `systemSchemaVersion: "2.0"\nmodels:\n  a:\n    source: a.em\n`, /unsupported systemSchemaVersion "2.0"/],
    ["unknown top-level key (a typo'd `seam:` must not silently declare nothing)", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseam: []\n`, /unknown top-level key "seam"/],
    ["no models", `systemSchemaVersion: "1.0"\nmodels: {}\n`, /at least one model/],
    ["models not a mapping", `systemSchemaVersion: "1.0"\nmodels:\n  - a.em\n`, /`models` must be a mapping/],
    ["model without source", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    owner: x\n`, /model "a": `source` must be a non-empty path string/],
    ["seams not a list", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  from: x\n`, /`seams` must be a list/],
    ["seam missing to", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  - from: a:x/event.y\n`, /seams\[0\]: `to` must be/],
    ["seam with unknown key", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  - from: a:x/event.y\n    to: a:z\n    via: kafka\n`, /seams\[0\]: unknown key "via"/],
    ["not a mapping at all", `- just\n- a list\n`, /manifest must be a YAML mapping/],
    ["unparseable YAML", `systemSchemaVersion: "1.0"\nmodels: [\n`, /YAML parse error/],
  ])("rejects %s with a system-manifest-invalid error", (_label, text, pattern) => {
    const r = parseManifest(text);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(d.code).toBe("system-manifest-invalid");
      expect(d.severity).toBe("error");
    }
    expect(r.diagnostics.map((d) => d.message).join("\n")).toMatch(pattern);
  });

  it("points a shape error at the offending line", () => {
    const r = parseManifest(`systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  - from: a:x/event.y\n    to: a:z\n  - from: only-from\n`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].line).toBe(8);
  });
});

describe("verifySystem — a verified seam", () => {
  const models = [modelInput("checkout", CHECKOUT, { owner: "Storefront" }), modelInput("fulfillment", FULFILLMENT)];
  const report = verifySystem(manifestOf(models, [{ ...SEAM, description: "orders flow to the warehouse" }]), models, "system.yaml");

  it("resolves both endpoints to element-level qualified refs and marks the seam verified", () => {
    expect(report.seams).toEqual([
      {
        from: "checkout:place/event.order-placed",
        to: "fulfillment:intake/translation.order-received",
        fromSlice: "checkout:place",
        toSlice: "fulfillment:intake",
        description: "orders flow to the warehouse",
        status: "verified",
        diagnostics: [],
      },
    ]);
  });

  it("lists each model's public surface (unqualified refs, export order) and the context map", () => {
    expect(report.models.map((m) => [m.key, m.name, m.owner, m.publicSurface])).toEqual([
      ["checkout", "Checkout", "Storefront", ["place/event.order-placed", "open-orders/view.open-orders"]],
      ["fulfillment", "Fulfillment", null, []],
    ]);
    expect(report.contextMap).toEqual({
      nodes: [
        { key: "checkout", name: "Checkout", owner: "Storefront" },
        { key: "fulfillment", name: "Fulfillment", owner: null },
      ],
      edges: [{ from: "checkout", to: "fulfillment", seams: 1 }],
    });
  });

  it("the only finding is the unconsumed public view (dangling-public-event), pointed at the model file", () => {
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        file: "checkout.em",
        severity: "warning",
        code: "dangling-public-event",
        line: 13,
        refs: ["checkout:open-orders/view.open-orders"],
      }),
    ]);
  });
});

describe("verifySystem — each diagnostic code", () => {
  const codesOf = (report: ReturnType<typeof verifySystem>) => report.diagnostics.map((d) => `${d.severity}:${d.code}`);

  it("system-model-key-mismatch: manifest key differs from the export's model.key, message names the computed key", () => {
    const models = [modelInput("storefront", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(manifestOf(models, [{ ...SEAM, from: "storefront:place/event.order-placed" }]), models, "system.yaml");
    const d = report.diagnostics.find((x) => x.code === "system-model-key-mismatch")!;
    expect(d.severity).toBe("error");
    expect(d.file).toBe("system.yaml");
    expect(d.line).toBe(4);
    expect(d.message).toContain('rename the manifest entry to "checkout"');
    // The seam still verifies against the manifest's own vocabulary — one error, not a cascade.
    expect(report.seams[0].status).toBe("verified");
  });

  it("system-manifest-invalid: a seam ref naming an unknown model key, or not qualified at all", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(
      manifestOf(models, [
        { from: "billing:place/event.order-placed", to: SEAM.to },
        { from: "place/event.order-placed", to: SEAM.to },
      ]),
      models,
      "system.yaml",
    );
    expect(report.seams.map((s) => s.status)).toEqual(["error", "error"]);
    const invalid = report.diagnostics.filter((d) => d.code === "system-manifest-invalid");
    expect(invalid).toHaveLength(2);
    expect(invalid[0].message).toContain('unknown model key "billing"');
    expect(invalid[0].message).toContain("declared models are: checkout, fulfillment");
    expect(invalid[1].message).toContain("must be a model-qualified ref");
    expect(invalid.map((d) => d.line)).toEqual([20, 23]);
  });

  it("seam-endpoint-unresolved: from/to refs that don't exist in the named model", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(
      manifestOf(models, [
        { from: "checkout:place/event.order-shipped", to: SEAM.to },
        { from: SEAM.from, to: "fulfillment:intake/translation.nope" },
        { from: SEAM.from, to: "fulfillment:no-such-slice" },
      ]),
      models,
      "system.yaml",
    );
    const unresolved = report.diagnostics.filter((d) => d.code === "seam-endpoint-unresolved");
    expect(unresolved.map((d) => d.severity)).toEqual(["error", "error", "error"]);
    expect(unresolved[0].message).toContain('no element "place/event.order-shipped" in model "checkout"');
    expect(unresolved[2].message).toContain('no slice "no-such-slice" in model "fulfillment"');
    expect(report.seams.map((s) => s.status)).toEqual(["error", "error", "error"]);
    // An unresolved endpoint echoes the ref as written; the resolved one is still element-level.
    expect(report.seams[0].from).toBe("checkout:place/event.order-shipped");
    expect(report.seams[0].fromSlice).toBeNull();
    expect(report.seams[0].to).toBe(SEAM.to);
  });

  it("seam-source-not-public: an event without `public`, and a command", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(
      manifestOf(models, [
        { from: "fulfillment:intake/event.order-accepted", to: SEAM.to },
        { from: "checkout:place/command.place-order", to: SEAM.to },
      ]),
      models,
      "system.yaml",
    );
    const notPublic = report.diagnostics.filter((d) => d.code === "seam-source-not-public");
    expect(notPublic).toHaveLength(2);
    expect(notPublic[0].message).toContain('event "Order Accepted" is not marked `public`');
    expect(notPublic[1].message).toContain("is a command, not a `public` event or view");
    expect(report.seams.map((s) => s.status)).toEqual(["error", "error"]);
    expect(report.seams.map((s) => s.diagnostics)).toEqual([["seam-source-not-public"], ["seam-source-not-public"]]);
  });

  it("seam-consumer-not-reaction: `to` names a view, a slice with no reaction, or a slice with two", () => {
    const TWO = `model "Two"
slice "Both" {
  processor First
  translation Second
  command Do It
  event Done
}
`;
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT), modelInput("two", TWO)];
    const report = verifySystem(
      manifestOf(models, [
        { from: SEAM.from, to: "fulfillment:to-ship/view.to-ship" },
        { from: SEAM.from, to: "fulfillment:to-ship" },
        { from: SEAM.from, to: "two:both" },
      ]),
      models,
      "system.yaml",
    );
    const notReaction = report.diagnostics.filter((d) => d.code === "seam-consumer-not-reaction");
    expect(notReaction.map((d) => d.severity)).toEqual(["error", "error", "error"]);
    expect(notReaction[0].message).toContain('view "To Ship" is not a reaction');
    expect(notReaction[1].message).toContain('slice "To Ship" has no reaction element');
    expect(notReaction[2].message).toContain('slice "Both" has 2 reaction elements (both/processor.first, both/translation.second)');
    expect(report.seams.map((s) => s.status)).toEqual(["error", "error", "error"]);
  });

  it("a bare slice `to` with exactly one reaction resolves to that element (element-level output)", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(manifestOf(models, [{ from: SEAM.from, to: "fulfillment:intake" }]), models, "system.yaml");
    expect(report.seams[0]).toMatchObject({
      to: "fulfillment:intake/translation.order-received",
      toSlice: "fulfillment:intake",
      status: "verified",
      diagnostics: [],
    });
    expect(report.diagnostics.map((d) => d.code)).not.toContain("unbound-translation");
  });

  it("seam-duplicate: the same resolved pair twice — a bare-slice spelling counts as the same seam", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(manifestOf(models, [SEAM, { from: SEAM.from, to: "fulfillment:intake" }]), models, "system.yaml");
    const dup = report.diagnostics.filter((d) => d.code === "seam-duplicate");
    expect(dup).toHaveLength(1);
    expect(dup[0].severity).toBe("warning");
    expect(dup[0].line).toBe(23);
    // A warning alone never fails a seam.
    expect(report.seams.map((s) => s.status)).toEqual(["verified", "verified"]);
    expect(report.seams[1].diagnostics).toEqual(["seam-duplicate"]);
    expect(report.contextMap.edges).toEqual([{ from: "checkout", to: "fulfillment", seams: 2 }]);
  });

  it("dangling-public-event: every public event/view no seam names as `from` — a system with no seams reports all of them", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(manifestOf(models, []), models, "system.yaml");
    expect(codesOf(report)).toEqual([
      "warning:dangling-public-event",
      "warning:dangling-public-event",
      "warning:unbound-translation",
    ]);
    expect(report.diagnostics[0].message).toContain('public event "Order Placed" (checkout:place/event.order-placed)');
    expect(report.diagnostics[1].message).toContain('public view "Open Orders" (checkout:open-orders/view.open-orders)');
    expect(report.contextMap.edges).toEqual([]);
  });

  it("unbound-translation: a reaction with no in-model incoming edge and no seam feeding it", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const report = verifySystem(manifestOf(models, []), models, "system.yaml");
    const unbound = report.diagnostics.filter((d) => d.code === "unbound-translation");
    expect(unbound).toEqual([
      expect.objectContaining({
        severity: "warning",
        file: "fulfillment.em",
        line: 7,
        refs: ["fulfillment:intake/translation.order-received"],
      }),
    ]);
    expect(unbound[0].message).toContain("has no in-model source and no seam feeds it");
  });

  it("unbound-translation is NOT raised for a reaction fed inside its own model (a `from` view) — externally fed is read off model.edges", () => {
    const INTERNAL = `model "Internal"
slice "Place" {
  ui Screen @Customer
  command Place Order
  event Order Placed @Order
}
slice "Queue" {
  view Orders To Ship from "Order Placed"
}
slice "Ship" {
  processor Shipper from "Orders To Ship"
  command Ship Order
  event Order Shipped @Order
}
slice "Shipped" {
  view Shipped Orders from "Order Shipped"
  ui Board @Ops
}
`;
    const models = [modelInput("internal", INTERNAL)];
    // Sanity: the export's own edge list is what says "fed inside".
    expect(models[0].doc.model.edges.some((e) => e.to === "ship/processor.shipper")).toBe(true);
    const report = verifySystem(manifestOf(models, []), models, "system.yaml");
    expect(report.diagnostics).toEqual([]);
  });

  it("undeclared-seam-candidate: a public element's name matches a reaction or event in another model with no seam between them", () => {
    const NAMED = `model "Notifications"
slice "Notify" {
  translation Order Placed
  command Send Receipt
  event Receipt Sent @Notify
}
slice "Mirror" {
  ui Enter @Ops
  command Mirror
  event Order Placed @Mirror
}
`;
    const models = [modelInput("checkout", CHECKOUT), modelInput("notifications", NAMED)];
    const undeclared = verifySystem(manifestOf(models, []), models, "system.yaml").diagnostics.filter((d) => d.code === "undeclared-seam-candidate");
    expect(undeclared).toHaveLength(2);
    expect(undeclared[0]).toMatchObject({
      severity: "warning",
      file: "checkout.em",
      line: 9,
      refs: ["checkout:place/event.order-placed", "notifications:notify/translation.order-placed"],
    });
    expect(undeclared[0].message).toContain("look connected by name, but no seam declares it — declare the seam or rename");
    expect(undeclared[1].refs).toEqual(["checkout:place/event.order-placed", "notifications:mirror/event.order-placed"]);

    // Declaring the seam into that model silences both candidates (the event match is "any seam
    // into model B from this element"; the reaction match is the exact pair).
    const declared = verifySystem(
      manifestOf(models, [{ from: "checkout:place/event.order-placed", to: "notifications:notify/translation.order-placed" }]),
      models,
      "system.yaml",
    );
    expect(declared.diagnostics.map((d) => d.code)).not.toContain("undeclared-seam-candidate");
  });

  it("never matches a public element against an element of its own model", () => {
    const SELF = `model "Self"
slice "Place" {
  ui Screen @Customer
  command Place Order
  event Order Placed @Order public
}
slice "React" {
  translation Order Placed
  command Ack
  event Acked
}
`;
    const models = [modelInput("self", SELF)];
    const codes = verifySystem(manifestOf(models, []), models, "system.yaml").diagnostics.map((d) => d.code);
    expect(codes).not.toContain("undeclared-seam-candidate");
  });
});

describe("buildSystemJson", () => {
  it("is deterministic: the same inputs produce byte-identical documents, with no timestamps", () => {
    const build = () => {
      const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
      const report = verifySystem(manifestOf(models, [SEAM]), models, "system.yaml");
      return buildSystemJson("system.yaml", "manifest text", report);
    };
    const a = build();
    const b = build();
    expect(a).toBe(b);
    const doc = JSON.parse(a);
    expect(doc.systemSchemaVersion).toBe(SYSTEM_SCHEMA_VERSION);
    expect(doc.generator.name).toBe("@milehimikey/em");
    expect(doc.manifest).toEqual({ path: "system.yaml", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), name: "Test System" });
    expect(Object.keys(doc)).toEqual(["systemSchemaVersion", "generator", "manifest", "models", "seams", "contextMap", "diagnostics"]);
    expect(doc.diagnostics[0]).toEqual({
      file: "checkout.em",
      severity: "warning",
      code: "dangling-public-event",
      message: expect.stringContaining("Open Orders"),
      line: 13,
      refs: ["checkout:open-orders/view.open-orders"],
    });
    expect(a).not.toMatch(/generatedAt|timestamp/);
  });
});

describe("loadSystem — `.em` and `.json` sources (real fs)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-system-"));
    mkdirSync(join(dir, "checkout"), { recursive: true });
    mkdirSync(join(dir, "exports"), { recursive: true });
    writeFileSync(join(dir, "checkout", "checkout.em"), CHECKOUT);
    // The fulfillment side arrives as an export document — the cross-repo/CI-aggregation case.
    writeFileSync(join(dir, "exports", "fulfillment.json"), JSON.stringify(exportOf(FULFILLMENT, "fulfillment.em"), null, 2));
    writeFileSync(join(dir, "exports", "old.json"), JSON.stringify({ schemaVersion: "1.9", model: { name: "Old", slices: [] } }));
    writeFileSync(join(dir, "exports", "not-json.json"), "{ nope");
    writeFileSync(join(dir, "broken.em"), 'slice "Read" {\n  view Open Orders from "No Such Event"\n}\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const manifest = (models: string, seams = "") =>
    `systemSchemaVersion: "1.0"\nname: Mixed\nmodels:\n${models}${seams ? `seams:\n${seams}` : ""}`;

  it("mixes a compiled .em source and an export .json source, feeding both to the one verifier", () => {
    const path = join(dir, "system.yaml");
    writeFileSync(
      path,
      manifest(
        "  checkout:\n    source: checkout/checkout.em\n  fulfillment:\n    source: exports/fulfillment.json\n    owner: Warehouse\n",
        `  - from: ${SEAM.from}\n    to: ${SEAM.to}\n`,
      ),
    );
    const loaded = loadSystem(path);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.models.map((m) => [m.key, m.sourceKind, m.file, m.doc.model.key])).toEqual([
      ["checkout", "em", join(dir, "checkout", "checkout.em"), "checkout"],
      ["fulfillment", "export", join(dir, "exports", "fulfillment.json"), "fulfillment"],
    ]);
    const report = verifySystem(loaded.manifest, loaded.models, path);
    expect(report.seams[0].status).toBe("verified");
    expect(report.models[1].owner).toBe("Warehouse");
  });

  it("refuses an export document older than schema 1.10 (no model.key / model.edges), naming the version", () => {
    const path = join(dir, "old.yaml");
    writeFileSync(path, manifest("  old:\n    source: exports/old.json\n"));
    const loaded = loadSystem(path);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]).toMatchObject({ file: path, code: "system-manifest-invalid", severity: "error", line: 4 });
    expect(loaded.diagnostics[0].message).toContain('schemaVersion "1.9"');
    expect(loaded.diagnostics[0].message).toContain(">= 1.10");
  });

  it("refuses a non-JSON export, a missing source, and a .em with validation errors — one diagnostic each", () => {
    const path = join(dir, "bad.yaml");
    writeFileSync(
      path,
      manifest("  a:\n    source: exports/not-json.json\n  b:\n    source: nowhere/missing.em\n  c:\n    source: broken.em\n"),
    );
    const loaded = loadSystem(path);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining("is not valid JSON"),
      expect.stringContaining("cannot read"),
      expect.stringContaining("has validation errors"),
    ]);
  });

  it("refuses an unreadable manifest", () => {
    const loaded = loadSystem(join(dir, "no-such.yaml"));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.diagnostics[0].message).toContain("cannot read");
  });

  it("readExportDoc accepts a future 2.x export and rejects a document with no model.key", () => {
    const ok = readExportDoc(JSON.stringify({ schemaVersion: "2.0", model: { key: "x", name: "X", slices: [], edges: [] } }), "x.json");
    expect("error" in ok).toBe(false);
    const noKey = readExportDoc(JSON.stringify({ schemaVersion: "1.10", model: { name: "X", slices: [], edges: [] } }), "x.json");
    expect("error" in noKey && noKey.error).toContain("no `model.key`");
  });
});
