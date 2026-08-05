// SPDX-License-Identifier: MIT
// Builds the `em glossary --json` document: a versioned, deterministic
// envelope around a `Glossary` + its `GlossaryConflict[]` (see
// ../model/glossary.ts). Its own `glossarySchemaVersion`, independent of `em
// export`'s `SCHEMA_VERSION` — a glossary is an N-model aggregate term
// dictionary, a different-shaped artifact than a single model's snapshot, and
// `em glossary` never reads or requires an existing `em export` document (it
// recompiles each input file itself, the same way `em diff` does).

import { createHash } from "node:crypto";
import { Glossary, GlossaryConflict } from "../model/glossary.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

export const GLOSSARY_SCHEMA_VERSION = "1.0";

/** One input file: what it was called on the command line, hashed source. */
export interface GlossaryFileSide {
  label: string;
  source: string;
}

function serializeSide(side: GlossaryFileSide) {
  return {
    label: side.label,
    sha256: createHash("sha256").update(side.source, "utf8").digest("hex"),
  };
}

/**
 * Build the `em glossary --json` document. Pretty-printed (2-space), no
 * trailing newline — the caller adds it, same convention as `buildExport`/
 * `buildDiffJson`.
 */
export function buildGlossaryJson(
  glossary: Glossary,
  conflicts: GlossaryConflict[],
  sources: GlossaryFileSide[],
): string {
  const doc = {
    glossarySchemaVersion: GLOSSARY_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    models: sources.map(serializeSide),
    elements: glossary.elements,
    fields: glossary.fields,
    personas: glossary.personas,
    contexts: glossary.contexts,
    conflicts,
  };
  return JSON.stringify(doc, null, 2);
}
