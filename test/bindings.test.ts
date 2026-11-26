// SPDX-License-Identifier: MIT
// Coverage for src/cli/bindings.ts (GH #449): the per-slice bindings manifest's shape validation
// (`parseBindingsFile`) and `em conform bindings check`'s core (`runBindingsCheck`) — pass/fail/
// missing-file/malformed-YAML/unknown-slice/unknown-ref, determinism, and the JSON/text
// renderers. CLI-level wiring (commander, exit codes, a real scratch repo) lives in
// test/cli-bindings.test.ts.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { rmTemp } from "./helpers/rmTemp.js";
import {
  bindingsFilePath,
  boundFilesForSlice,
  buildBindingsCheckJson,
  listBindingsSliceKeys,
  parseBindingsFile,
  renderBindingsCheckText,
  runBindingsCheck,
  BINDINGS_CHECK_SCHEMA_VERSION,
  BINDINGS_SCHEMA_VERSION,
} from "../src/cli/bindings.js";

const MODEL = `slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed
}
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
`;

const VALID_YAML = `bindingsSchemaVersion: "1.0"
slice: place-order
elements:
  - ref: command.place-order
    file: src/handler.ts
    identifier: placeOrder
  - ref: event.order-placed
    file: src/handler.ts
    identifier: OrderPlaced
    note: emitted by the same handler
invariants:
  - id: INV-PO-1
    enforcedIn: {file: src/handler.ts, identifier: validateStock}
    testedIn: {file: src/handler.test.ts, identifier: "validates stock"}
`;

describe("bindingsFilePath", () => {
  it("is conformance/bindings/<slice-key>.yaml", () => {
    expect(bindingsFilePath("place-order")).toBe("conformance/bindings/place-order.yaml");
  });
});

describe("parseBindingsFile", () => {
  it("accepts a well-formed file", () => {
    const result = parseBindingsFile(VALID_YAML, "place-order");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual({
      bindingsSchemaVersion: "1.0",
      slice: "place-order",
      elements: [
        { ref: "command.place-order", file: "src/handler.ts", identifier: "placeOrder", note: null },
        { ref: "event.order-placed", file: "src/handler.ts", identifier: "OrderPlaced", note: "emitted by the same handler" },
      ],
      invariants: [
        {
          id: "INV-PO-1",
          enforcedIn: { file: "src/handler.ts", identifier: "validateStock" },
          testedIn: { file: "src/handler.test.ts", identifier: "validates stock" },
        },
      ],
    });
  });

  it("accepts a minimal file with no elements/invariants", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "1.0"\nslice: place-order\n', "place-order");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.elements).toEqual([]);
    expect(result.doc.invariants).toEqual([]);
  });

  it("accepts explicit empty lists", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "1.0"\nslice: place-order\nelements: []\ninvariants: []\n', "place-order");
    expect(result.ok).toBe(true);
  });

  it("rejects malformed YAML with a line-numbered message", () => {
    const result = parseBindingsFile("bindingsSchemaVersion: \"1.0\"\nslice: [unterminated\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("YAML parse error");
  });

  it("rejects a missing bindingsSchemaVersion", () => {
    const result = parseBindingsFile("slice: place-order\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("bindingsSchemaVersion"))).toBe(true);
  });

  it("rejects an unsupported bindingsSchemaVersion", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "2.0"\nslice: place-order\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('unsupported bindingsSchemaVersion "2.0"');
  });

  it("rejects a slice field that doesn't match the file's expected name", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "1.0"\nslice: wrong-slice\n', "place-order");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("does not match this file's name");
  });

  it("rejects an unknown top-level key", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "1.0"\nslice: place-order\nextra: true\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("unknown top-level key");
  });

  it("rejects an element missing a required field", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - ref: command.place-order\n    file: src/handler.ts\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("identifier"))).toBe(true);
  });

  it("rejects a malformed ref shape", () => {
    const result = parseBindingsFile(
      'bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - ref: "Not A Ref"\n    file: src/handler.ts\n    identifier: x\n',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('doesn\'t look like "<kind>.<slug>"');
  });

  it("rejects an invariant id that doesn't look like INV-*", () => {
    const result = parseBindingsFile(
      'bindingsSchemaVersion: "1.0"\nslice: place-order\ninvariants:\n  - id: "NOT-AN-ID"\n' +
        "    enforcedIn: {file: a.ts, identifier: x}\n    testedIn: {file: b.ts, identifier: y}\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("doesn't look like an INV-* token");
  });

  it("rejects elements that is not a list", () => {
    const result = parseBindingsFile('bindingsSchemaVersion: "1.0"\nslice: place-order\nelements: "not a list"\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("`elements` must be a list");
  });

  it("the module's own version constant matches what the parser accepts", () => {
    expect(BINDINGS_SCHEMA_VERSION).toBe("1.0");
  });
});

describe("parseBindingsFile: repo (schema 1.1, GH #531)", () => {
  const head = (v: string) => `bindingsSchemaVersion: "${v}"\nslice: place-order\n`;
  const WITH_REPO =
    `elements:\n  - {ref: ui.checkout, repo: storefront-web, file: src/Checkout.tsx, identifier: Checkout}\n  - {ref: command.place-order, file: src/handler.ts, identifier: placeOrder}\n` +
    `invariants:\n  - id: INV-PO-1\n    enforcedIn: {repo: self, file: src/handler.ts, identifier: validate}\n    testedIn: {file: src/handler.test.ts, identifier: validates}\n`;

  it("reads repo on elements and invariant sites; a binding without one carries no repo key", () => {
    const r = parseBindingsFile(head("1.1") + WITH_REPO, "place-order");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.bindingsSchemaVersion).toBe("1.1");
    expect(r.doc.elements).toEqual([
      { ref: "ui.checkout", file: "src/Checkout.tsx", identifier: "Checkout", note: null, repo: "storefront-web" },
      { ref: "command.place-order", file: "src/handler.ts", identifier: "placeOrder", note: null },
    ]);
    expect(r.doc.invariants).toEqual([
      { id: "INV-PO-1", enforcedIn: { file: "src/handler.ts", identifier: "validate", repo: "self" }, testedIn: { file: "src/handler.test.ts", identifier: "validates" } },
    ]);
  });

  it("a 1.1 file with no repo reads the same as its 1.0 twin, apart from the version", () => {
    const body = `elements:\n  - {ref: command.place-order, file: src/handler.ts, identifier: placeOrder}\n`;
    const a = parseBindingsFile(head("1.0") + body, "place-order");
    const b = parseBindingsFile(head("1.1") + body, "place-order");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect({ ...b.doc, bindingsSchemaVersion: "1.0" }).toEqual(a.doc);
  });

  it("refuses repo under 1.0, naming the version to set, on an element and on a site", () => {
    const r = parseBindingsFile(head("1.0") + WITH_REPO, "place-order");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      'line 4: elements[0]: `repo:` needs bindingsSchemaVersion "1.1" — set `bindingsSchemaVersion: "1.1"` (nothing else in the file changes)',
      'line 8: invariants[0].enforcedIn: `repo:` needs bindingsSchemaVersion "1.1" — set `bindingsSchemaVersion: "1.1"` (nothing else in the file changes)',
    ]);
  });

  it.each([
    [`elements:\n  - {ref: ui.checkout, repo: "two words", file: a, identifier: b}\n`, "elements[0]: `repo` must be a repo id"],
    [`elements:\n  - {ref: ui.checkout, repo: ../web, file: a, identifier: b}\n`, "elements[0]: `repo` must be a repo id"],
    [`invariants:\n  - id: INV-A-1\n    enforcedIn: {repo: 7, file: a, identifier: b}\n    testedIn: {file: a, identifier: b}\n`, "invariants[0].enforcedIn: `repo` must be a repo id"],
    [`elements:\n  - {ref: ui.checkout, path: x, file: a, identifier: b}\n`, 'elements[0]: unknown key "path" — expected ref, file, identifier, note, repo'],
  ])("1.1 refuses %j", (body, message) => {
    const r = parseBindingsFile(head("1.1") + body, "place-order");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain(message);
  });

  it("an unsupported version names both accepted ones", () => {
    const r = parseBindingsFile(head("2.0"), "place-order");
    expect(!r.ok && r.errors.join("\n")).toContain('this em accepts "1.0" and "1.1"');
  });
});

describe("runBindingsCheck", () => {
  let modelDir: string;
  let repoDir: string;
  const refsOf = (source: string) => compile(source).refs;

  function writeBindings(sliceKey: string, text: string) {
    mkdirSync(join(modelDir, "conformance", "bindings"), { recursive: true });
    writeFileSync(join(modelDir, bindingsFilePath(sliceKey)), text);
  }

  it("passes every binding when every file/identifier/ref checks out", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("place-order", VALID_YAML);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "handler.ts"),
      "export function placeOrder() { validateStock(); emit('OrderPlaced'); }\nfunction validateStock() {}\n",
    );
    writeFileSync(join(repoDir, "src", "handler.test.ts"), 'it("validates stock", () => {});\n');

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result.ok).toBe(true);
    expect(result.slice).toBeNull();
    expect(result.summary).toEqual({
      filesChecked: 1,
      filesOk: 1,
      filesFailed: 0,
      elementsChecked: 2,
      elementsOk: 2,
      elementsFailed: 0,
      invariantsChecked: 1,
      invariantsOk: 1,
      invariantsFailed: 0,
    });
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("fails an element whose file doesn't exist under --repo", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("place-order", 'bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - ref: command.place-order\n    file: src/missing.ts\n    identifier: x\n');

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result.ok).toBe(false);
    const el = result.files[0].elements[0];
    expect(el).toMatchObject({ knownRef: true, fileExists: false, identifierFound: false, ok: false });
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("fails an element whose identifier isn't present in an existing file", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("place-order", 'bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - ref: command.place-order\n    file: src/handler.ts\n    identifier: nope\n');
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "handler.ts"), "export function placeOrder() {}\n");

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result.ok).toBe(false);
    expect(result.files[0].elements[0]).toMatchObject({ fileExists: true, identifierFound: false, ok: false });
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("fails as unknown-ref when an element's ref isn't among the model's own export refs", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings(
      "place-order",
      'bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n  - ref: command.does-not-exist\n    file: src/handler.ts\n    identifier: x\n',
    );
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "handler.ts"), "export function placeOrder() {}\n");

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result.ok).toBe(false);
    const file = result.files[0];
    expect(file.kind).toBe("checked");
    if (file.kind !== "checked") return;
    expect(file.elements[0]).toMatchObject({ ref: "command.does-not-exist", knownRef: false, fileExists: null, identifierFound: null, ok: false });
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("reports a distinct 'missing' kind when --slice names a slice with no bindings file", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir, "place-order");
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([
      { path: "conformance/bindings/place-order.yaml", slice: "place-order", kind: "missing", ok: false, errors: [expect.stringContaining("no bindings file")], elements: [], invariants: [] },
    ]);
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("reports a distinct 'malformed' kind for invalid YAML, surfacing every parse error", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("place-order", 'bindingsSchemaVersion: "1.0"\nslice: place-order\nelements: "oops"\n');

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir, "place-order");
    expect(result.ok).toBe(false);
    expect(result.files[0].kind).toBe("malformed");
    expect(result.files[0].errors.length).toBeGreaterThan(0);
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("reports a distinct 'unknown-slice' kind when a file's slice isn't in the model (scan mode)", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("ghost-slice", 'bindingsSchemaVersion: "1.0"\nslice: ghost-slice\n');

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result.ok).toBe(false);
    expect(result.files[0]).toMatchObject({ kind: "unknown-slice", slice: "ghost-slice" });
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("is ok with zero files when conformance/bindings/ doesn't exist (bindings are opt-in)", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));

    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result).toEqual({ ok: true, slice: null, files: [], summary: { filesChecked: 0, filesOk: 0, filesFailed: 0, elementsChecked: 0, elementsOk: 0, elementsFailed: 0, invariantsChecked: 0, invariantsOk: 0, invariantsFailed: 0 } });
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("scans every conformance/bindings/*.yaml in sorted order when no --slice is given", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("place-order", 'bindingsSchemaVersion: "1.0"\nslice: place-order\n');
    writeBindings("open-orders", 'bindingsSchemaVersion: "1.0"\nslice: open-orders\n');

    expect(listBindingsSliceKeys(modelDir)).toEqual(["open-orders", "place-order"]);
    const result = runBindingsCheck(refsOf(MODEL), modelDir, repoDir);
    expect(result.files.map((f) => f.slice)).toEqual(["open-orders", "place-order"]);
    rmTemp(modelDir);
    rmTemp(repoDir);
  });

  it("is deterministic: the same inputs produce byte-identical JSON across repeated runs", () => {
    modelDir = mkdtempSync(join(tmpdir(), "em-bindings-model-"));
    repoDir = mkdtempSync(join(tmpdir(), "em-bindings-repo-"));
    writeBindings("place-order", VALID_YAML);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "handler.ts"), "export function placeOrder() { validateStock(); }\nfunction validateStock() {}\n");
    writeFileSync(join(repoDir, "src", "handler.test.ts"), 'it("validates stock", () => {});\n');

    const refs = refsOf(MODEL);
    const a = buildBindingsCheckJson(runBindingsCheck(refs, modelDir, repoDir));
    const b = buildBindingsCheckJson(runBindingsCheck(refs, modelDir, repoDir));
    expect(a).toBe(b);
    rmTemp(modelDir);
    rmTemp(repoDir);
  });
});

describe("buildBindingsCheckJson", () => {
  it("carries its own schema version constant and explicit nulls", () => {
    const json = buildBindingsCheckJson({
      ok: true,
      slice: null,
      files: [],
      summary: { filesChecked: 0, filesOk: 0, filesFailed: 0, elementsChecked: 0, elementsOk: 0, elementsFailed: 0, invariantsChecked: 0, invariantsOk: 0, invariantsFailed: 0 },
    });
    const parsed = JSON.parse(json);
    expect(parsed.bindingsCheckSchemaVersion).toBe(BINDINGS_CHECK_SCHEMA_VERSION);
    expect(parsed.slice).toBeNull();
    expect(parsed.files).toEqual([]);
  });
});

describe("renderBindingsCheckText", () => {
  it("prints a note, not a failure, when nothing was found scanning", () => {
    const text = renderBindingsCheckText({ ok: true, slice: null, files: [], summary: { filesChecked: 0, filesOk: 0, filesFailed: 0, elementsChecked: 0, elementsOk: 0, elementsFailed: 0, invariantsChecked: 0, invariantsOk: 0, invariantsFailed: 0 } });
    expect(text).toContain("no bindings files found");
  });

  it("names the requested slice when --slice found nothing", () => {
    const text = renderBindingsCheckText({ ok: true, slice: "place-order", files: [], summary: { filesChecked: 0, filesOk: 0, filesFailed: 0, elementsChecked: 0, elementsOk: 0, elementsFailed: 0, invariantsChecked: 0, invariantsOk: 0, invariantsFailed: 0 } });
    expect(text).toContain('slice "place-order"');
  });

  it("prints a summary line with the four counted totals", () => {
    const refs = compile(MODEL).refs;
    const modelDir = mkdtempSync(join(tmpdir(), "em-bindings-render-"));
    mkdirSync(join(modelDir, "conformance", "bindings"), { recursive: true });
    writeFileSync(join(modelDir, bindingsFilePath("place-order")), 'bindingsSchemaVersion: "1.0"\nslice: place-order\n');
    const result = runBindingsCheck(refs, modelDir, modelDir);
    const text = renderBindingsCheckText(result);
    expect(text).toMatch(/summary: 1 file\(s\) checked, 0 failed; 0 element binding\(s\), 0 failed; 0 invariant binding\(s\), 0 failed/);
    rmTemp(modelDir);
  });
});

describe("boundFilesForSlice (GH #523)", () => {
  it("lists each bound file once, elements then invariant sites, with a leading ./ dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-bound-files-"));
    try {
      mkdirSync(join(dir, "conformance", "bindings"), { recursive: true });
      writeFileSync(
        join(dir, bindingsFilePath("place-order")),
        `bindingsSchemaVersion: "1.0"\nslice: place-order\nelements:\n` +
          `  - {ref: command.place-order, file: ./src/handler.ts, identifier: placeOrder}\n` +
          `  - {ref: event.order-placed, file: src/handler.ts, identifier: OrderPlaced}\n` +
          `invariants:\n  - id: INV-PO-1\n    enforcedIn: {file: src/rules.ts, identifier: check}\n    testedIn: {file: test/rules.test.ts, identifier: check}\n`,
      );
      writeFileSync(join(dir, bindingsFilePath("broken")), "slice: [not, a, mapping\n");
      expect(boundFilesForSlice(dir, "place-order")).toEqual(["src/handler.ts", "src/rules.ts", "test/rules.test.ts"]);
      expect(boundFilesForSlice(dir, "broken")).toEqual([]);
      expect(boundFilesForSlice(dir, "no-such-slice")).toEqual([]);
    } finally {
      rmTemp(dir);
    }
  });
});
