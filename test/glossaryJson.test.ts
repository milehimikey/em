// SPDX-License-Identifier: MIT
// Coverage for `em glossary --json`'s serializer (src/emit/glossaryJson.ts):
// envelope shape, generator/schema-version fields, source hashing, and
// determinism. Term collection/conflict detection is covered by
// test/glossary.test.ts; this file tests the serialization layer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compile } from "../src/pipeline.js";
import { buildGlossary, detectKindConflicts, GlossaryModelInput } from "../src/model/glossary.js";
import { buildGlossaryJson, GLOSSARY_SCHEMA_VERSION } from "../src/emit/glossaryJson.js";

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const A_SRC = `
slice "Checkout" {
  event Order
}
`;
const B_SRC = `
slice "Billing" {
  view Order
}
`;

function inputs(): { glossaryInputs: GlossaryModelInput[]; sources: { label: string; source: string }[] } {
  const glossaryInputs = [
    { label: "a.em", model: compile(A_SRC).model },
    { label: "b.em", model: compile(B_SRC).model },
  ];
  const sources = [
    { label: "a.em", source: A_SRC },
    { label: "b.em", source: B_SRC },
  ];
  return { glossaryInputs, sources };
}

describe("buildGlossaryJson", () => {
  it("carries schema version, generator, hashed sources, terms, and conflicts", () => {
    const { glossaryInputs, sources } = inputs();
    const glossary = buildGlossary(glossaryInputs);
    const conflicts = detectKindConflicts(glossary);
    const doc = JSON.parse(buildGlossaryJson(glossary, conflicts, sources));

    expect(doc.glossarySchemaVersion).toBe(GLOSSARY_SCHEMA_VERSION);
    expect(doc.generator).toEqual({ name: "@milehimikey/em", version: PKG_VERSION });
    expect(doc.models).toEqual([
      { label: "a.em", sha256: sha256(A_SRC) },
      { label: "b.em", sha256: sha256(B_SRC) },
    ]);
    expect(doc.elements).toEqual(glossary.elements);
    expect(doc.fields).toEqual(glossary.fields);
    expect(doc.personas).toEqual(glossary.personas);
    expect(doc.contexts).toEqual(glossary.contexts);
    expect(doc.conflicts).toEqual(conflicts);
    expect(doc.conflicts).toHaveLength(1);
    expect(doc.conflicts[0].type).toBe("kind-conflict");
  });

  it("is byte-identical for identical inputs (determinism)", () => {
    const { glossaryInputs, sources } = inputs();
    const glossary = buildGlossary(glossaryInputs);
    const conflicts = detectKindConflicts(glossary);
    const first = buildGlossaryJson(glossary, conflicts, sources);
    const second = buildGlossaryJson(buildGlossary(inputs().glossaryInputs), detectKindConflicts(glossary), inputs().sources);
    expect(second).toBe(first);
  });

  it("has no trailing newline — the caller adds one", () => {
    const { glossaryInputs, sources } = inputs();
    const glossary = buildGlossary(glossaryInputs);
    const text = buildGlossaryJson(glossary, [], sources);
    expect(text.endsWith("\n")).toBe(false);
  });
});
