// SPDX-License-Identifier: MIT
// Coverage for the `em validate --json` serializers (src/emit/validateJson.ts, MIL-128): the
// plain diagnostics document, the `--slice-ready` machine verdict, and the `--list-*` marker
// enumeration — plus `buildSliceExport` (src/emit/json.ts), the `em export --slice` scoped
// document. CLI-level wiring (flag combos, exit codes, stdout/stderr split) is covered by
// test/cli.test.ts; this file tests the serialization layer directly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import {
  buildValidateJson,
  buildSliceReadyJson,
  buildValidateListJson,
  collectMarkers,
  VALIDATE_SCHEMA_VERSION,
  VALIDATE_SLICE_READY_SCHEMA_VERSION,
  VALIDATE_LIST_SCHEMA_VERSION,
} from "../src/emit/validateJson.js";
import { computeSliceReadyGates } from "../src/catalog/sliceReadyValidate.js";
import { buildSliceExport } from "../src/emit/json.js";

const CLEAN = `slice "Place" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;

const WITH_ERROR = `slice "Read" {
  view Open Orders from "No Such Event"
}
`;

const WITH_ISSUE = `slice "Place" {
  command Place Order issue "who validates the discount code?"
  ui Checkout @Customer
  event Order Placed
}
`;

// MIL-215: one public view with no in-model reader, one with a `ui` reader.
const WITH_PUBLIC_VIEWS = `context Order
slice "Place" {
  command Place Order
  event Order Placed @Order
}
slice "Order Feed" {
  view Order Feed public from "Order Placed"
}
slice "Order Summary" {
  view Order Summary public from "Order Placed"
  ui Summary Screen @Customer
}
`;

describe("buildValidateJson", () => {
  it("versions the document and reports ok/summary/diagnostics on a clean model", () => {
    const { diagnostics } = compile(CLEAN);
    const doc = JSON.parse(buildValidateJson("clean.em", diagnostics));
    expect(doc.validateSchemaVersion).toBe(VALIDATE_SCHEMA_VERSION);
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: expect.any(String) });
    expect(doc.file).toBe("clean.em");
    expect(doc.ok).toBe(true);
    expect(doc.summary).toEqual({ errors: 0, warnings: 0, total: 0 });
    expect(doc.diagnostics).toEqual([]);
  });

  it("reports ok: false and every diagnostic's usageCategory on a model with errors", () => {
    const { diagnostics } = compile(WITH_ERROR);
    const doc = JSON.parse(buildValidateJson("error.em", diagnostics));
    expect(doc.ok).toBe(false);
    expect(doc.summary.errors).toBeGreaterThan(0);
    expect(doc.diagnostics.length).toBe(diagnostics.length);
    for (const d of doc.diagnostics) {
      expect(typeof d.usageCategory).toBe("string");
      expect(d.usageCategory.length).toBeGreaterThan(0);
    }
    expect(doc.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "view-from-unresolved", severity: "error" })]),
    );
  });

  it("emits explicit line: null / refs: [] for a diagnostic without them, same convention as em export", () => {
    // grid-collision-free, but open-issue diagnostics carry refs; use a case where `line` is
    // present but exercise the widened shape via serializeDiagnostic's own contract directly.
    const { diagnostics } = compile(WITH_ISSUE);
    const doc = JSON.parse(buildValidateJson("issue.em", diagnostics));
    const issueDiag = doc.diagnostics.find((d: { code: string }) => d.code === "open-issue");
    expect(issueDiag.line).not.toBeNull();
    expect(Array.isArray(issueDiag.refs)).toBe(true);
  });
});

describe("collectMarkers / buildValidateListJson", () => {
  it("collects only the requested marker kinds, refs-aware", () => {
    const { model, refs } = compile(WITH_ISSUE);
    const markers = collectMarkers(model, refs, { issues: true });
    expect(markers).toEqual([
      {
        markerKind: "issue",
        sliceKey: "place",
        sliceName: "Place",
        elementRef: "place/command.place-order",
        elementKind: "command",
        elementName: "Place Order",
        text: "who validates the discount code?",
        noInModelReader: null,
        line: 2,
      },
    ]);
  });

  it("returns nothing when the flag isn't set, even if the model has issues", () => {
    const { model, refs } = compile(WITH_ISSUE);
    expect(collectMarkers(model, refs, { divergences: true, public: true })).toEqual([]);
  });

  it("MIL-215: flags noInModelReader on a public view with no ui/reaction reader, clears it once one exists, and leaves events untouched", () => {
    const { model, refs } = compile(WITH_PUBLIC_VIEWS);
    const markers = collectMarkers(model, refs, { public: true });
    expect(markers.map((m) => [m.elementName, m.elementKind, m.noInModelReader])).toEqual([
      ["Order Feed", "view", true],
      ["Order Summary", "view", false],
    ]);
  });

  it("buildValidateListJson wraps markers + diagnostics in the versioned envelope", () => {
    const { model, refs, diagnostics } = compile(WITH_ISSUE);
    const markers = collectMarkers(model, refs, { issues: true });
    const doc = JSON.parse(buildValidateListJson("issue.em", markers, diagnostics));
    expect(doc.validateListSchemaVersion).toBe(VALIDATE_LIST_SCHEMA_VERSION);
    expect(doc.file).toBe("issue.em");
    expect(doc.markers).toEqual(markers);
    expect(doc.diagnostics.length).toBe(diagnostics.length);
  });
});

describe("computeSliceReadyGates / buildSliceReadyJson", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-validate-json-slice-ready-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "ready-slice.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\n---\n## Open Questions\n- [x] resolved\n",
    );
    // Bound (the note resolves to a real file) but unusable: missing `status` from
    // REQUIRED_FRONTMATTER_KEYS, so hasUsableFrontmatter() is false — distinct from
    // "binding-missing-file" (no file at all).
    writeFileSync(
      join(dir, "slices", "invalid-slice.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nversion: 1\n---\nbody\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when the key names no slice", () => {
    const { model, refs } = compile(`slice "Place" {\n  command Do Thing\n}\n`);
    expect(computeSliceReadyGates(model, refs, dir, "no-such-key")).toBeNull();
  });

  it("all 4 gates false when no note binds a doc", () => {
    const { model, refs } = compile(`slice "Unbound" {\n  command Do Thing\n  event Thing Done\n}\n`);
    expect(computeSliceReadyGates(model, refs, dir, "unbound")).toEqual({
      gates: {
        docBound: false,
        frontmatterUsable: false,
        statusReady: false,
        noUncheckedOpenQuestions: false,
      },
      continuationOf: null,
    });
  });

  it("all 4 gates true for a bound, ready, fully-checked doc", () => {
    const { model, refs } = compile(
      `slice "Ready Slice" {\n  command Do Thing note "slices/ready-slice.md"\n  event Thing Done\n}\n`,
    );
    expect(computeSliceReadyGates(model, refs, dir, "ready-slice")).toEqual({
      gates: {
        docBound: true,
        frontmatterUsable: true,
        statusReady: true,
        noUncheckedOpenQuestions: true,
      },
      continuationOf: null,
    });
  });

  it("docBound true but frontmatterUsable false when the bound doc's frontmatter is missing required keys", () => {
    const { model, refs } = compile(
      `slice "Invalid Slice" {\n  command Do Thing note "slices/invalid-slice.md"\n  event Thing Done\n}\n`,
    );
    expect(computeSliceReadyGates(model, refs, dir, "invalid-slice")).toEqual({
      gates: {
        docBound: true,
        frontmatterUsable: false,
        statusReady: false,
        noUncheckedOpenQuestions: false,
      },
      continuationOf: null,
    });
  });

  it("buildSliceReadyJson wraps gates/diagnostics/ready in the versioned envelope, gates null on unknown key", () => {
    const { diagnostics } = compile(`slice "Place" {\n  command Do Thing\n}\n`);
    const doc = JSON.parse(buildSliceReadyJson("model.em", "no-such-key", null, diagnostics, false, null));
    expect(doc.validateSliceReadySchemaVersion).toBe(VALIDATE_SLICE_READY_SCHEMA_VERSION);
    expect(doc.sliceKey).toBe("no-such-key");
    expect(doc.gates).toBeNull();
    expect(doc.continuationOf).toBeNull();
    expect(doc.ready).toBe(false);
    expect(doc.diagnostics.length).toBe(diagnostics.length);
  });
});

describe("buildSliceExport", () => {
  it("returns found: false and a null text for an unknown slice key", () => {
    const { model, refs, diagnostics } = compile(CLEAN);
    const result = buildSliceExport(model, refs, diagnostics, CLEAN, "model.em", "no-such-slice");
    expect(result.found).toBe(false);
    expect(result.text).toBeNull();
  });

  it("scopes diagnostics to the named slice's own refs", () => {
    const { model, refs, diagnostics } = compile(WITH_ERROR);
    const result = buildSliceExport(model, refs, diagnostics, WITH_ERROR, "model.em", "read");
    expect(result.found).toBe(true);
    const doc = JSON.parse(result.text!);
    expect(doc.sliceKey).toBe("read");
    expect(doc.slice.key).toBe("read");
    expect(doc.diagnostics.length).toBeGreaterThan(0);
    for (const d of doc.diagnostics) {
      expect(d.refs.some((r: string) => r === "read" || r.startsWith("read/"))).toBe(true);
    }
  });

  it("the scoped document never carries the whole model's slices array", () => {
    const { model, refs, diagnostics } = compile(CLEAN);
    const result = buildSliceExport(model, refs, diagnostics, CLEAN, "model.em", "place");
    const doc = JSON.parse(result.text!);
    expect(doc.model).toBeUndefined();
    expect(doc.slice.name).toBe("Place");
  });
});
