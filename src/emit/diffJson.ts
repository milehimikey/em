// SPDX-License-Identifier: MIT
// Builds the `em diff --json` document: a versioned, deterministic envelope
// around `ModelDiff` (see ../model/diff.ts). Follows `em export`'s
// conventions (src/emit/json.ts): a schema field versioned independently of
// the npm package, explicit `null` for every optional field so consumers can
// destructure without sniffing, and byte-deterministic output.

import { createHash } from "node:crypto";
import { ChangeEntry, ChangeType, ModelDiff, hasChanges } from "../model/diff.js";
import { Diagnostic, serializeDiagnostic } from "../model/validate.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.5 (MIL-91): diagnostics gain `code`/`refs`, same structured-diagnostics retrofit as
// `em export`'s SCHEMA_VERSION 1.4 — an independent cadence/field, bumped on its own.
export const DIFF_SCHEMA_VERSION = "1.5";

/** One side of the diff: what it was called, its source text, and its warnings. */
export interface DiffSide {
  /** A file path, or `path@rev` for the `--from`/`--to` form. */
  label: string;
  /** Source text, hashed into the envelope so a consumer can pin what was diffed. */
  source: string;
  /** This side's validate() diagnostics — warnings only; `em diff` refuses on errors. */
  diagnostics: Diagnostic[];
}

/**
 * `ChangeEntry` with every optional field widened to an explicit `null`. Mapped
 * off `ChangeEntry` rather than hand-listed so adding a field there is a
 * compile error here, not a field that silently stops being serialized.
 */
type SerializedEntry = { type: ChangeType } & {
  [K in Exclude<keyof ChangeEntry, "type">]-?: NonNullable<ChangeEntry[K]> | null;
};

/** `ChangeEntry` with every optional field present, explicit `null` when unused by `type`. */
function serializeEntry(e: ChangeEntry): SerializedEntry {
  return {
    type: e.type,
    kind: e.kind ?? null,
    name: e.name ?? null,
    ref: e.ref ?? null,
    sliceName: e.sliceName ?? null,
    sliceKey: e.sliceKey ?? null,
    fromSlice: e.fromSlice ?? null,
    fromSliceKey: e.fromSliceKey ?? null,
    toSlice: e.toSlice ?? null,
    toSliceKey: e.toSliceKey ?? null,
    field: e.field ?? null,
    fieldType: e.fieldType ?? null,
    oldType: e.oldType ?? null,
    newType: e.newType ?? null,
    source: e.source ?? null,
    oldSource: e.oldSource ?? null,
    newSource: e.newSource ?? null,
    oldNote: e.oldNote ?? null,
    newNote: e.newNote ?? null,
    oldText: e.oldText ?? null,
    newText: e.newText ?? null,
    from: e.from ?? null,
    to: e.to ?? null,
    acceptedDivergence: e.acceptedDivergence ?? null,
  };
}

/**
 * `serializeDiagnostic()` (`model/validate.ts`) — the same shape `em export` uses — plus the
 * `side` it came from. Flat and side-tagged rather than `{ old: [...], new: [...] }` so the
 * array stays filterable and no key is a reserved word (see `oldModel`/`newModel` below).
 */
function serializeSideDiagnostic(side: "old" | "new") {
  return (d: Diagnostic) => ({ side, ...serializeDiagnostic(d) });
}

function serializeSide(side: DiffSide) {
  return {
    label: side.label,
    sha256: createHash("sha256").update(side.source, "utf8").digest("hex"),
  };
}

/**
 * Build the `em diff --json` document for an already-computed `ModelDiff`.
 * Pretty-printed (2-space), no trailing newline — the caller adds it.
 */
export function buildDiffJson(diff: ModelDiff, oldSide: DiffSide, newSide: DiffSide): string {
  const doc = {
    diffSchemaVersion: DIFF_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    oldModel: serializeSide(oldSide),
    newModel: serializeSide(newSide),
    identical: !hasChanges(diff),
    counts: diff.counts,
    changes: diff.changes.map(serializeEntry),
    removals: diff.removals.map(serializeEntry),
    diagnostics: [
      ...oldSide.diagnostics.map(serializeSideDiagnostic("old")),
      ...newSide.diagnostics.map(serializeSideDiagnostic("new")),
    ],
  };
  return JSON.stringify(doc, null, 2);
}
