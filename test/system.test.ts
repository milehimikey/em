// SPDX-License-Identifier: MIT
// Unit coverage for `em system` (MIL-194, MIL-235): the manifest parser (src/system/manifest.ts:
// 2.0 shape, 1.0 read compatibility), the export-only verifier (src/system/verify.ts) — `consumes`
// resolution and its two error codes, the MIL-194 checks re-derived from `consumes`, one test per
// legacy seam code — the fs loader (src/cli/systemInputs.ts: `.json` sources, discovery via
// `git ls-files` and the non-git walk), and determinism of the --json document.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/pipeline.js";
import { buildExportDoc } from "../src/emit/json.js";
import {
  parseManifest,
  SystemManifest,
  SYSTEM_MANIFEST_SCHEMA_VERSION,
  LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION,
} from "../src/system/manifest.js";
import { verifySystem, SystemExportDoc, SystemModelInput } from "../src/system/verify.js";
import { discoverModelFiles, loadSystem, readExportDoc } from "../src/cli/systemInputs.js";
import { buildSystemJson, SYSTEM_SCHEMA_VERSION } from "../src/emit/systemJson.js";
import { makeMultiModelRepo } from "./helpers/multiModelRepo.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");
function em(args: string[], cwd: string) {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

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

/** FULFILLMENT with its translation bound consumer-side (MIL-235). */
const FULFILLMENT_CONSUMING = FULFILLMENT.replace("translation Order Received", "translation Order Received consumes checkout:event.order-placed");

/** Compile `.em` text into exactly the export-document slice the verifier reads — the same
 *  `compile()` + `buildExportDoc()` path src/cli/systemInputs.ts takes for a `.em` source. */
function exportOf(text: string, file = "model.em"): SystemExportDoc {
  const { model, refs, diagnostics } = compile(text);
  const { doc } = buildExportDoc(model, refs, diagnostics, text, file);
  return doc;
}

function modelInput(key: string, text: string, extra: Partial<SystemModelInput> = {}): SystemModelInput {
  const file = `${key}.em`;
  const doc = exportOf(text, file);
  return { key, source: file, sourceKind: "em", owner: doc.model.owner ?? [], file, doc, ...extra };
}

/** A 2.0 manifest over `models` — or, when `seams` are given, a legacy 1.0 one carrying them
 *  (the only shape that can still declare manifest seams). */
function manifestOf(models: SystemModelInput[], seams: Array<{ from: string; to: string; description?: string }> = []): SystemManifest {
  return {
    systemSchemaVersion: seams.length > 0 ? LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION : SYSTEM_MANIFEST_SCHEMA_VERSION,
    versionLine: 1,
    name: "Test System",
    models: models.map((m, i) => ({ key: m.key, source: m.source, owner: null, line: 4 + i * 2 })),
    seams: seams.map((s, i) => ({ from: s.from, to: s.to, description: s.description ?? null, line: 20 + i * 3 })),
  };
}

/** Diagnostics minus the legacy-manifest warning every 1.0 fixture carries. */
const withoutOutdated = <T extends { code: string }>(ds: T[]) => ds.filter((d) => d.code !== "system-manifest-outdated");

const SEAM = { from: "checkout:place/event.order-placed", to: "fulfillment:intake/translation.order-received" };

describe("parseManifest", () => {
  it("parses the 2.0 shape: name + models {key: {source}} only", () => {
    const r = parseManifest(`systemSchemaVersion: "2.0"
name: Shop
models:
  checkout:
    source: models/checkout/checkout.em
  fulfillment:
    source: models/fulfillment/fulfillment.em
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics).toEqual([]);
    expect(r.manifest).toEqual({
      systemSchemaVersion: "2.0",
      versionLine: 1,
      name: "Shop",
      models: [
        { key: "checkout", source: "models/checkout/checkout.em", owner: null, line: 4 },
        { key: "fulfillment", source: "models/fulfillment/fulfillment.em", owner: null, line: 6 },
      ],
      seams: [],
    });
  });

  it("still READS the legacy 1.0 shape (seams + owners) — `em system` warns, `em upgrade` migrates", () => {
    const r = parseManifest(`systemSchemaVersion: "1.0"
name: Shop
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
    expect(r.manifest.systemSchemaVersion).toBe("1.0");
    expect(r.manifest.models).toEqual([
      { key: "checkout", source: "models/checkout/checkout.em", owner: "Storefront team", line: 4 },
      { key: "fulfillment", source: "models/fulfillment/fulfillment.em", owner: null, line: 7 },
    ]);
    expect(r.manifest.seams).toEqual([
      { from: "checkout:checkout/event.order-placed", to: "fulfillment:intake/translation.order-received", description: "optional free text", line: 10 },
      { from: "checkout:checkout/event.order-paid", to: "fulfillment:intake", description: null, line: 13 },
    ]);
  });

  it("accepts JSON (a YAML subset)", () => {
    const r = parseManifest(JSON.stringify({ systemSchemaVersion: "2.0", models: { a: { source: "a.em" } } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBeNull();
      expect(r.manifest.seams).toEqual([]);
    }
  });

  it("2.0 refuses `seams:` and a model `owner:` with exact messages pointing at em upgrade", () => {
    const r = parseManifest(`systemSchemaVersion: "2.0"
models:
  a:
    source: a.em
    owner: Team A
seams:
  - from: a:x/event.y
    to: b:z
`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => [d.code, d.severity, d.line, d.message])).toEqual([
      [
        "system-manifest-invalid",
        "error",
        6,
        '`seams:` is not part of systemSchemaVersion "2.0" — a seam is declared on the consuming translation ' +
          "(`consumes <modelKey>:<kind>.<slug>`); run `em upgrade <model>.em --apply` to migrate",
      ],
      [
        "system-manifest-invalid",
        "error",
        5,
        'model "a": `owner:` is not part of systemSchemaVersion "2.0" — owners live on the model header ' +
          '(`model "Name" owner "Team"`); run `em upgrade <model>.em --apply` to migrate',
      ],
    ]);
  });

  it.each([
    ["missing version", `models:\n  a:\n    source: a.em\n`, /missing or non-string `systemSchemaVersion`/],
    ["YAML float version, not a string", `systemSchemaVersion: 2.0\nmodels:\n  a:\n    source: a.em\n`, /missing or non-string `systemSchemaVersion`/],
    [
      "unsupported version",
      `systemSchemaVersion: "3.0"\nmodels:\n  a:\n    source: a.em\n`,
      /^unsupported systemSchemaVersion "3\.0" — this em accepts "2\.0" \(and reads "1\.0" for compatibility\)$/,
    ],
    ["unknown top-level key (a typo'd `seam:` must not silently declare nothing)", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseam: []\n`, /unknown top-level key "seam"/],
    ["unknown 2.0 model key", `systemSchemaVersion: "2.0"\nmodels:\n  a:\n    source: a.em\n    team: x\n`, /model "a": unknown key "team" — expected source$/],
    ["no models", `systemSchemaVersion: "2.0"\nmodels: {}\n`, /at least one model/],
    ["models not a mapping", `systemSchemaVersion: "2.0"\nmodels:\n  - a.em\n`, /`models` must be a mapping/],
    ["model without source", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    owner: x\n`, /model "a": `source` must be a non-empty path string/],
    ["seams not a list (1.0)", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  from: x\n`, /`seams` must be a list/],
    ["seam missing to (1.0)", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  - from: a:x/event.y\n`, /seams\[0\]: `to` must be/],
    ["seam with unknown key (1.0)", `systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  - from: a:x/event.y\n    to: a:z\n    via: kafka\n`, /seams\[0\]: unknown key "via"/],
    ["not a mapping at all", `- just\n- a list\n`, /manifest must be a YAML mapping/],
    ["unparseable YAML", `systemSchemaVersion: "2.0"\nmodels: [\n`, /YAML parse error/],
  ])("rejects %s with a system-manifest-invalid error", (_label, text, pattern) => {
    const r = parseManifest(text);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(d.code).toBe("system-manifest-invalid");
      expect(d.severity).toBe("error");
    }
    expect(r.diagnostics.some((d) => pattern.test(d.message))).toBe(true);
  });

  it("points a shape error at the offending line", () => {
    const r = parseManifest(`systemSchemaVersion: "1.0"\nmodels:\n  a:\n    source: a.em\nseams:\n  - from: a:x/event.y\n    to: a:z\n  - from: only-from\n`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].line).toBe(8);
  });
});

describe("verifySystem — `consumes` bindings (MIL-235)", () => {
  const OWNED = CHECKOUT.replace('model "Checkout"', 'model "Checkout" owner "Storefront", "Payments"');
  const models = [modelInput("checkout", OWNED), modelInput("fulfillment", FULFILLMENT_CONSUMING)];
  const report = verifySystem(manifestOf(models), models, "system.yaml");

  it("resolves the consumes ref to the producer's public element and lists it as a verified seam", () => {
    expect(report.seams).toEqual([
      {
        from: "checkout:place/event.order-placed",
        to: "fulfillment:intake/translation.order-received",
        fromSlice: "checkout:place",
        toSlice: "fulfillment:intake",
        description: null,
        status: "verified",
        diagnostics: [],
      },
    ]);
  });

  it("owners come from the model header (string[]); the context map edge is derived from consumes", () => {
    expect(report.models.map((m) => [m.key, m.owner, m.publicSurface])).toEqual([
      ["checkout", ["Storefront", "Payments"], ["place/event.order-placed", "open-orders/view.open-orders"]],
      ["fulfillment", [], []],
    ]);
    expect(report.contextMap).toEqual({
      nodes: [
        { key: "checkout", name: "Checkout", owner: ["Storefront", "Payments"] },
        { key: "fulfillment", name: "Fulfillment", owner: [] },
      ],
      edges: [{ from: "checkout", to: "fulfillment", seams: 1 }],
    });
  });

  it("dangling-public-event is re-derived from consumes: only the unconsumed public view is left, exact message", () => {
    expect(report.diagnostics).toEqual([
      {
        file: "checkout.em",
        severity: "warning",
        code: "dangling-public-event",
        message:
          'public view "Open Orders" (checkout:open-orders/view.open-orders) is consumed by nothing in this system — add ' +
          "`consumes checkout:view.open-orders` to the translation that reads it, or drop `public`",
        line: 13,
        refs: ["checkout:open-orders/view.open-orders"],
      },
    ]);
  });

  it("a view is consumable too (kind view)", () => {
    const both = FULFILLMENT.replace(
      "translation Order Received",
      "translation Order Received consumes checkout:event.order-placed, checkout:view.open-orders",
    );
    const ms = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", both)];
    const r = verifySystem(manifestOf(ms), ms, "system.yaml");
    expect(r.seams.map((x) => [x.from, x.status])).toEqual([
      ["checkout:place/event.order-placed", "verified"],
      ["checkout:open-orders/view.open-orders", "verified"],
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.contextMap.edges).toEqual([{ from: "checkout", to: "fulfillment", seams: 2 }]);
  });

  it("consumes-unknown-model: exact message, refs on both sides, pointed at the consumer's line", () => {
    const text = FULFILLMENT.replace("translation Order Received", "translation Order Received consumes billing:event.order-placed");
    const ms = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", text)];
    const r = verifySystem(manifestOf(ms), ms, "system.yaml");
    const d = r.diagnostics.find((x) => x.code === "consumes-unknown-model")!;
    expect(d).toEqual({
      file: "fulfillment.em",
      severity: "error",
      code: "consumes-unknown-model",
      message:
        'translation "Order Received" (fulfillment:intake/translation.order-received) consumes "billing:event.order-placed", ' +
        'but this system has no model "billing" — models are: checkout, fulfillment',
      line: 7,
      refs: ["fulfillment:intake/translation.order-received", "billing:event.order-placed"],
    });
    expect(r.seams).toEqual([
      {
        from: "billing:event.order-placed",
        to: "fulfillment:intake/translation.order-received",
        fromSlice: null,
        toSlice: "fulfillment:intake",
        description: null,
        status: "error",
        diagnostics: ["consumes-unknown-model"],
      },
    ]);
    // The consumer still counts as bound — one error, not an unbound-translation on top of it.
    expect(r.diagnostics.map((x) => x.code)).not.toContain("unbound-translation");
    expect(r.contextMap.edges).toEqual([]);
  });

  it("consumes-unknown-element: no such element, and an element that exists but is not public — exact messages", () => {
    const AUDIT = `model "Audit"
slice "Intake" {
  translation Audit Intake consumes checkout:event.order-shipped, fulfillment:event.order-accepted
  command Record
  event Recorded
}
`;
    const ms = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT_CONSUMING), modelInput("audit", AUDIT)];
    const r = verifySystem(manifestOf(ms), ms, "system.yaml");
    const unknown = r.diagnostics.filter((x) => x.code === "consumes-unknown-element");
    expect(unknown.map((x) => [x.file, x.severity, x.line, x.refs, x.message])).toEqual([
      [
        "audit.em",
        "error",
        3,
        ["audit:intake/translation.audit-intake", "checkout:event.order-shipped"],
        'translation "Audit Intake" (audit:intake/translation.audit-intake) consumes "checkout:event.order-shipped", ' +
          'but model "checkout" has no public event "order-shipped"',
      ],
      [
        "audit.em",
        "error",
        3,
        ["audit:intake/translation.audit-intake", "fulfillment:event.order-accepted"],
        'translation "Audit Intake" (audit:intake/translation.audit-intake) consumes "fulfillment:event.order-accepted", ' +
          'but event "Order Accepted" (fulfillment:intake/event.order-accepted) is not marked `public` in model "fulfillment"',
      ],
    ]);
    expect(r.seams.filter((x) => x.to.startsWith("audit:")).map((x) => x.status)).toEqual(["error", "error"]);
  });

  it("seam-duplicate: the same ref twice on one translation", () => {
    const text = FULFILLMENT.replace(
      "translation Order Received",
      "translation Order Received consumes checkout:event.order-placed consumes checkout:event.order-placed",
    );
    const ms = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", text)];
    const r = verifySystem(manifestOf(ms), ms, "system.yaml");
    const dup = r.diagnostics.filter((x) => x.code === "seam-duplicate");
    expect(dup.map((x) => [x.severity, x.message])).toEqual([
      [
        "warning",
        'translation "Order Received" (fulfillment:intake/translation.order-received) binds "checkout:event.order-placed" more than once — remove the repeated `consumes` ref',
      ],
    ]);
    expect(r.seams.map((x) => x.status)).toEqual(["verified", "verified"]);
  });

  it("unbound-translation is re-derived from consumes: a translation with no consumes and no in-model source — exact message", () => {
    const ms = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const r = verifySystem(manifestOf(ms), ms, "system.yaml");
    expect(r.diagnostics.filter((d) => d.code === "unbound-translation")).toEqual([
      {
        file: "fulfillment.em",
        severity: "warning",
        code: "unbound-translation",
        message:
          'translation "Order Received" (fulfillment:intake/translation.order-received) has no in-model source and consumes nothing — ' +
          "add `consumes <modelKey>:<kind>.<slug>` naming the public event/view that feeds it, or add a `from`",
        line: 7,
        refs: ["fulfillment:intake/translation.order-received"],
      },
    ]);
  });

  it("unbound-translation on a non-translation reaction says only a translation can consume", () => {
    const AUTO = `model "Auto"
slice "Tick" {
  automation Nightly Sweep
  command Sweep
  event Swept
}
`;
    const ms = [modelInput("auto", AUTO)];
    const d = verifySystem(manifestOf(ms), ms, "system.yaml").diagnostics.find((x) => x.code === "unbound-translation")!;
    expect(d.message).toBe(
      'automation "Nightly Sweep" (auto:tick/automation.nightly-sweep) has no in-model source and nothing binds it — ' +
        "add a `from` (only a translation can `consumes` another model's public surface)",
    );
  });

  it("undeclared-seam-candidate is silenced by a consumes binding between the two", () => {
    const NAMED = `model "Notifications"
slice "Notify" {
  translation Order Placed
  command Send Receipt
  event Receipt Sent @Notify
}
`;
    const ms = [modelInput("checkout", CHECKOUT), modelInput("notifications", NAMED)];
    const before = verifySystem(manifestOf(ms), ms, "system.yaml").diagnostics.filter((d) => d.code === "undeclared-seam-candidate");
    expect(before.map((d) => d.message)).toEqual([
      'public event "Order Placed" (checkout:place/event.order-placed) and translation "Order Placed" (notifications:notify/translation.order-placed) ' +
        "look connected by name, but no `consumes` binds them — add the `consumes` ref to the consuming translation, or rename",
    ]);
    const bound = [modelInput("checkout", CHECKOUT), modelInput("notifications", NAMED.replace("translation Order Placed", "translation Order Placed consumes checkout:event.order-placed"))];
    const after = verifySystem(manifestOf(bound), bound, "system.yaml");
    expect(after.diagnostics.map((d) => d.code)).not.toContain("undeclared-seam-candidate");
  });

  it("an export document older than 1.15 (no `consumes`, no `owner`) reads as no bindings and no owners", () => {
    const doc = exportOf(FULFILLMENT_CONSUMING, "fulfillment.em") as unknown as { model: { owner?: unknown; slices: { elements: { consumes?: unknown }[] }[] } };
    delete doc.model.owner;
    for (const sl of doc.model.slices) for (const el of sl.elements) delete el.consumes;
    const ms = [modelInput("checkout", CHECKOUT), { ...modelInput("fulfillment", FULFILLMENT), doc: doc as unknown as SystemExportDoc }];
    const r = verifySystem(manifestOf(ms), ms, "system.yaml");
    expect(r.seams).toEqual([]);
  });

  it("discovery mode (manifest null): no name, no manifest-key check, keys as given", () => {
    const ms = [modelInput("checkout~2", CHECKOUT), modelInput("fulfillment", FULFILLMENT_CONSUMING.replace("checkout:event", "checkout~2:event"))];
    const r = verifySystem(null, ms, null);
    expect(r.name).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).not.toContain("system-model-key-mismatch");
    expect(r.seams.map((x) => [x.from, x.status])).toEqual([["checkout~2:place/event.order-placed", "verified"]]);
  });
});

describe("verifySystem — legacy 1.0 manifest", () => {
  it("system-manifest-outdated: a 1.0 manifest still verifies, with one warning at the version line — exact message", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT)];
    const manifest = { ...manifestOf(models, [SEAM]), versionLine: 4 };
    const r = verifySystem(manifest, models, "system.yaml");
    expect(r.diagnostics[0]).toEqual({
      file: "system.yaml",
      severity: "warning",
      code: "system-manifest-outdated",
      message:
        'systemSchemaVersion "1.0" is outdated — seams now live on the consuming translation (`consumes <modelKey>:<kind>.<slug>`) ' +
        'and owners on the model header (`model "Name" owner "Team"`); run `em upgrade <model>.em --apply` once to migrate this manifest to "2.0"',
      line: 4,
    });
    expect(r.seams.map((x) => x.status)).toEqual(["verified"]);
  });

  it("a 1.0 seam a consumes clause already declares is a seam-duplicate", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT_CONSUMING)];
    const r = verifySystem(manifestOf(models, [SEAM]), models, "system.yaml");
    const dup = r.diagnostics.find((d) => d.code === "seam-duplicate")!;
    expect(dup.message).toBe(`seams[0] (${SEAM.from} -> ${SEAM.to}): already declared by a \`consumes\` clause`);
    expect(r.contextMap.edges).toEqual([{ from: "checkout", to: "fulfillment", seams: 2 }]);
  });
});

describe("verifySystem — a verified legacy seam", () => {
  const models = [modelInput("checkout", CHECKOUT, { owner: ["Storefront"] }), modelInput("fulfillment", FULFILLMENT)];
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
      ["checkout", "Checkout", ["Storefront"], ["place/event.order-placed", "open-orders/view.open-orders"]],
      ["fulfillment", "Fulfillment", [], []],
    ]);
    expect(report.contextMap).toEqual({
      nodes: [
        { key: "checkout", name: "Checkout", owner: ["Storefront"] },
        { key: "fulfillment", name: "Fulfillment", owner: [] },
      ],
      edges: [{ from: "checkout", to: "fulfillment", seams: 1 }],
    });
  });

  it("besides the outdated-manifest warning, the only finding is the unconsumed public view (dangling-public-event)", () => {
    expect(withoutOutdated(report.diagnostics)).toEqual([
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

describe("verifySystem — each legacy seam diagnostic code", () => {
  const codesOf = (report: ReturnType<typeof verifySystem>) => withoutOutdated(report.diagnostics).map((d) => `${d.severity}:${d.code}`);

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
    expect(unbound[0].message).toContain("has no in-model source and consumes nothing");
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
    const report = verifySystem(manifestOf(models), models, "system.yaml");
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
    expect(undeclared[0].message).toContain("look connected by name, but no `consumes` binds them");
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
      return buildSystemJson({ manifestPath: "system.yaml", manifestText: "manifest text", discovery: null }, report);
    };
    const a = build();
    const b = build();
    expect(a).toBe(b);
    const doc = JSON.parse(a);
    expect(doc.systemSchemaVersion).toBe(SYSTEM_SCHEMA_VERSION);
    expect(doc.generator.name).toBe("@milehimikey/em");
    expect(doc.manifest).toEqual({ path: "system.yaml", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), name: "Test System" });
    expect(Object.keys(doc)).toEqual(["systemSchemaVersion", "generator", "manifest", "models", "seams", "contextMap", "discovery", "diagnostics"]);
    expect(doc.systemSchemaVersion).toBe("2.0");
    expect(doc.discovery).toBeNull();
    expect(doc.diagnostics[0].code).toBe("system-manifest-outdated");
    expect(doc.diagnostics[1]).toEqual({
      file: "checkout.em",
      severity: "warning",
      code: "dangling-public-event",
      message: expect.stringContaining("Open Orders"),
      line: 13,
      refs: ["checkout:open-orders/view.open-orders"],
    });
    expect(a).not.toMatch(/generatedAt|timestamp/);
  });

  it("discovery: `manifest` is null and `discovery` carries root + files", () => {
    const models = [modelInput("checkout", CHECKOUT), modelInput("fulfillment", FULFILLMENT_CONSUMING)];
    const report = verifySystem(null, models, null);
    const doc = JSON.parse(buildSystemJson({ manifestPath: null, manifestText: null, discovery: { root: ".", files: ["checkout.em", "fulfillment.em"] } }, report));
    expect(doc.manifest).toBeNull();
    expect(doc.discovery).toEqual({ root: ".", files: ["checkout.em", "fulfillment.em"] });
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
    `systemSchemaVersion: "${seams ? "1.0" : "2.0"}"\nname: Mixed\nmodels:\n${models}${seams ? `seams:\n${seams}` : ""}`;

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
    // A legacy manifest owner fills in when the model header names none.
    expect(report.models[1].owner).toEqual(["Warehouse"]);
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

describe("discovery — no manifest (MIL-235, R4)", () => {
  it("in a git repo: `git ls-files '*.em'` from the repo root — tracked only, .gitignore honoured, *-asis.em skipped", () => {
    const repo = makeMultiModelRepo({ manifest: false });
    try {
      // An ignored model, an untracked one, and a tracked as-is seed: none of them is a member.
      writeFileSync(join(repo.dir, ".gitignore"), "scratch/\n");
      mkdirSync(join(repo.dir, "scratch"));
      writeFileSync(join(repo.dir, "scratch", "ignored.em"), 'model "Ignored"\n');
      writeFileSync(join(repo.dir, "models", "checkout", "checkout-asis.em"), 'model "Checkout As Is"\n');
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "noise");
      writeFileSync(join(repo.dir, "untracked.em"), 'model "Untracked"\n');

      // Started from a subdirectory, discovery still lists the whole repo, root reached relatively.
      const sub = join(repo.dir, "models", "checkout");
      expect(discoverModelFiles(sub)).toEqual({
        root: join(sub, "..", ".."),
        files: ["models/checkout/checkout.em", "models/fulfillment/fulfillment.em"],
      });
      expect(discoverModelFiles(repo.dir).root).toBe(repo.dir);
    } finally {
      repo.cleanup();
    }
  });

  it("outside git: a sorted walk of the start directory, pruning node_modules/.git and *-asis.em", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-discover-"));
    try {
      mkdirSync(join(dir, "b"), { recursive: true });
      mkdirSync(join(dir, "a"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(dir, "b", "b.em"), 'model "B"\n');
      writeFileSync(join(dir, "a", "a.em"), 'model "A"\n');
      writeFileSync(join(dir, "a", "a-asis.em"), 'model "A As Is"\n');
      writeFileSync(join(dir, "node_modules", "pkg", "x.em"), 'model "X"\n');
      // Only meaningful when tmpdir itself is not inside a git work tree.
      const inGit = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).status === 0;
      if (inGit) return;
      expect(discoverModelFiles(dir)).toEqual({ root: dir, files: ["a/a.em", "b/b.em"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadSystem(<dir>) uses the directory's system.yaml when present, else discovers — both find the example's two models", () => {
    const withManifest = makeMultiModelRepo();
    const without = makeMultiModelRepo({ manifest: false });
    try {
      const a = loadSystem(withManifest.dir);
      expect(a.ok && a.manifestPath).toBe(join(withManifest.dir, "system.yaml"));
      const b = loadSystem(without.dir);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.manifest).toBeNull();
      expect(b.models.map((m) => [m.key, m.source, m.owner])).toEqual([
        ["checkout", "models/checkout/checkout.em", ["Storefront team"]],
        ["fulfillment", "models/fulfillment/fulfillment.em", ["Warehouse team"]],
      ]);
      const report = verifySystem(b.manifest, b.models, b.manifestPath, b.diagnostics);
      expect(report.seams.map((x) => [x.from, x.to, x.status])).toEqual([
        ["checkout:checkout/event.order-submitted", "fulfillment:receive-order/translation.order-intake", "verified"],
      ]);
      expect(report.diagnostics.map((d) => d.code)).toEqual(["dangling-public-event"]);
    } finally {
      withManifest.cleanup();
      without.cleanup();
    }
  });

  it("two discovered models with one key: the second is addressed `~2` and a duplicate-model-key warning leads", () => {
    const repo = makeMultiModelRepo({ manifest: false });
    try {
      mkdirSync(join(repo.dir, "zz"));
      writeFileSync(join(repo.dir, "zz", "copy.em"), 'model "Checkout"\nslice "S" {\n  ui Screen @U\n  command Do\n  event Done\n}\n');
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "dup");
      const loaded = loadSystem(repo.dir);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.models.map((m) => m.key)).toEqual(["checkout", "fulfillment", "checkout~2"]);
      expect(loaded.diagnostics.map((d) => d.code)).toEqual(["duplicate-model-key"]);
    } finally {
      repo.cleanup();
    }
  });

  it("refuses a directory with no manifest and no models", () => {
    const repo = makeMultiModelRepo({ manifest: false });
    try {
      repo.git("rm", "-q", "-r", "models");
      repo.git("commit", "-q", "-m", "empty");
      const loaded = loadSystem(repo.dir);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.diagnostics[0].message).toBe(
        `no system.yaml and no .em models found under ${repo.dir} — pass a manifest, or run from the repository that holds the models`,
      );
    } finally {
      repo.cleanup();
    }
  });

  it("CLI: `em system` with no argument reads ./system.yaml, and with none discovers (root \".\")", () => {
    const repo = makeMultiModelRepo();
    try {
      const withManifest = em(["system", "--json"], repo.dir);
      expect(withManifest.status).toBe(0);
      expect(JSON.parse(withManifest.stdout).manifest.path).toBe("system.yaml");
      repo.git("rm", "-q", "system.yaml");
      repo.git("commit", "-q", "-m", "no manifest");
      const discovered = em(["system"], repo.dir);
      expect(discovered.status).toBe(0);
      expect(discovered.stdout.split("\n")[0]).toBe("system: 2 models, 1 seam (1 verified, 0 failing) (discovered under . — no system.yaml)");
      const json = JSON.parse(em(["system", "--json"], repo.dir).stdout);
      expect(json.manifest).toBeNull();
      expect(json.discovery).toEqual({ root: ".", files: ["models/checkout/checkout.em", "models/fulfillment/fulfillment.em"] });
    } finally {
      repo.cleanup();
    }
  }, 30000);
});
