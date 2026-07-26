// SPDX-License-Identifier: MIT
// Builds the `em diff --json` document: a versioned, deterministic envelope
// around `ModelDiff` (see ../model/diff.ts). Follows `em export`'s
// conventions (src/emit/json.ts): a schema field versioned independently of
// the npm package, explicit `null` for every optional field so consumers can
// destructure without sniffing, and byte-deterministic output.

import { ChangeEntry, ModelDiff, hasChanges } from "../model/diff.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

export const DIFF_SCHEMA_VERSION = "1.0";

/** `ChangeEntry` with every optional field present, explicit `null` when unused by `type`. */
function serializeEntry(e: ChangeEntry) {
  return {
    type: e.type,
    kind: e.kind ?? null,
    name: e.name ?? null,
    sliceName: e.sliceName ?? null,
    fromSlice: e.fromSlice ?? null,
    toSlice: e.toSlice ?? null,
    field: e.field ?? null,
    fieldType: e.fieldType ?? null,
    oldType: e.oldType ?? null,
    newType: e.newType ?? null,
    source: e.source ?? null,
    oldNote: e.oldNote ?? null,
    newNote: e.newNote ?? null,
    oldText: e.oldText ?? null,
    newText: e.newText ?? null,
    from: e.from ?? null,
    to: e.to ?? null,
  };
}

/**
 * Build the `em diff --json` document for an already-computed `ModelDiff`.
 * Pretty-printed (2-space), no trailing newline — the caller adds it.
 */
export function buildDiffJson(diff: ModelDiff, oldLabel: string, newLabel: string): string {
  const doc = {
    diffSchemaVersion: DIFF_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    old: { label: oldLabel },
    new: { label: newLabel },
    identical: !hasChanges(diff),
    counts: diff.counts,
    changes: diff.changes.map(serializeEntry),
    removals: diff.removals.map(serializeEntry),
  };
  return JSON.stringify(doc, null, 2);
}
