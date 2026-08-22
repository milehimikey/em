// SPDX-License-Identifier: MIT
// Builds the three `em validate --json` document shapes (MIL-128): the plain diagnostics
// document, the `--slice-ready <key>` machine verdict, and the `--list-issues`/
// `--list-divergences`/`--list-public` structured enumeration. Follows `em export`/`em diff`'s
// conventions (json.ts/diffJson.ts): a schema field versioned independently of the npm package
// and of every other command's own schema, explicit `null` for an unused optional field, and
// byte-deterministic output for the same inputs.
//
// Why `em validate` needed `--json` at all (the ticket's own framing): `em export`'s
// diagnostics carry `code`/`refs` already, but `em export` refuses to run on an errored model —
// precisely when an agent most needs structured diagnostics, the structured path was closed.
// `em validate --json` works on an errored model by design; that's the whole point.
//
// Every diagnostic emitted here also carries `usageCategory`, sourced from the `RULES`
// registry (model/rules.ts) — the same fixed vocabulary docs/usage-data.md's Categories tables
// already draw from. No new judgment: this module only reshapes what the validator and
// `RULES` already compute, never adds a check of its own.

import { Diagnostic, serializeDiagnostic } from "../model/validate.js";
import { RULES, RuleCode } from "../model/rules.js";
import { Element, NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { SliceReadyGates } from "../catalog/sliceReadyValidate.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

/** `serializeDiagnostic()`'s shape plus `usageCategory`, looked up from `RULES` — every
 *  diagnostic `em validate --json` emits, in all three modes below, carries it. Trusts the
 *  same invariant `makeDiag`/`pushDiag` (model/rules.ts) already enforce: a diagnostic's
 *  `code` is always a registered `RuleCode`, or construction would have thrown already. */
function serializeDiagnosticWithUsage(d: Diagnostic) {
  return { ...serializeDiagnostic(d), usageCategory: RULES[d.code as RuleCode].usageCategory };
}

// 1.0 (MIL-128): initial shape.
export const VALIDATE_SCHEMA_VERSION = "1.0";

/** Build the plain `em validate <file> --json` document — the serialized diagnostics array
 *  (stable `code`s, `refs`, line numbers, `usageCategory`) plus a pass/fail summary. Works on
 *  a model with errors; `ok` mirrors `!hasErrors(diagnostics)`, the same predicate that gates
 *  `em validate`'s exit code. */
export function buildValidateJson(file: string, diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const doc = {
    validateSchemaVersion: VALIDATE_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    ok: errors === 0,
    summary: { errors, warnings: diagnostics.length - errors, total: diagnostics.length },
    diagnostics: diagnostics.map(serializeDiagnosticWithUsage),
  };
  return JSON.stringify(doc, null, 2);
}

// 1.0 (MIL-128): initial shape.
export const VALIDATE_SLICE_READY_SCHEMA_VERSION = "1.0";

/** Build the `em validate <file> --slice-ready <key> --json` document — the machine verdict
 *  replacing the two hand-parsed English sentences ("is ready-to-implement" /
 *  "is NOT ready-to-implement") plus scraped warning prose. `gates` names each of the 4
 *  conditions individually (see `computeSliceReadyGates`, catalog/sliceReadyValidate.ts);
 *  `null` when `sliceKey` matches no slice in the model (the `slice-ready-unknown-slice` error
 *  case — nothing to gate). `ready` is the same predicate driving `em validate`'s exit code
 *  for `--slice-ready` (scoped diagnostics empty) — it is the AND of the 4 gates only when
 *  `gates` is non-null AND nothing else concerning this slice is broken (e.g. a plain
 *  both-ends-of-a-flow diagnostic on one of its own elements); `diagnostics` carries that full
 *  scoped list so a consumer sees exactly why, never just the 4 named gates. */
export function buildSliceReadyJson(
  file: string,
  sliceKey: string,
  gates: SliceReadyGates | null,
  diagnostics: Diagnostic[],
  ready: boolean,
): string {
  const doc = {
    validateSliceReadySchemaVersion: VALIDATE_SLICE_READY_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    sliceKey,
    gates,
    ready,
    diagnostics: diagnostics.map(serializeDiagnosticWithUsage),
  };
  return JSON.stringify(doc, null, 2);
}

// 1.0 (MIL-128): initial shape.
export const VALIDATE_LIST_SCHEMA_VERSION = "1.0";

/** One `--list-issues`/`--list-divergences`/`--list-public` entry — the structured replacement
 *  for the `  issue :12 slice "X" command "Y": text` eyeball format. `elementRef` is the same
 *  export-stable ref (`<sliceKey>/<kind>.<slug>`) `em export`/`em diff` use — never a second
 *  identifier scheme. `text` is the `issue`/`divergence` annotation's own text; `null` for a
 *  `public` marker, which carries no text. */
export interface MarkerEntry {
  markerKind: "issue" | "divergence" | "public";
  sliceKey: string;
  sliceName: string;
  elementRef: string;
  elementKind: string;
  elementName: string;
  text: string | null;
  line: number;
}

/** Collects `--list-issues`/`--list-divergences`/`--list-public` markers straight off the
 *  model, in document order — the same element sets cli.ts's `printIssues`/`printDivergences`/
 *  `printPublicElements` already walk, just refs-aware and machine-shaped instead of printed.
 *  Each `kinds` flag independently gates its own marker kind, same as the text-mode flags. */
export function collectMarkers(
  model: NormalizedModel,
  refs: RefsResult,
  kinds: { issues?: boolean; divergences?: boolean; public?: boolean },
): MarkerEntry[] {
  const markers: MarkerEntry[] = [];
  const entryFor = (el: Element, markerKind: MarkerEntry["markerKind"], text: string | null): MarkerEntry => ({
    markerKind,
    sliceKey: refs.sliceKeys[el.sliceIndex],
    sliceName: model.slices[el.sliceIndex].name,
    elementRef: refs.refById.get(el.id)!,
    elementKind: el.kind,
    elementName: el.name,
    text,
    line: el.line,
  });
  if (kinds.issues) {
    for (const el of model.elements) if (el.issue) markers.push(entryFor(el, "issue", el.issue));
  }
  if (kinds.divergences) {
    for (const el of model.elements) if (el.divergence) markers.push(entryFor(el, "divergence", el.divergence));
  }
  if (kinds.public) {
    for (const el of model.elements) {
      if (el.public && (el.kind === "event" || el.kind === "view")) markers.push(entryFor(el, "public", null));
    }
  }
  return markers;
}

/** Build the `--list-issues`/`--list-divergences`/`--list-public --json` document. `markers`
 *  is whatever `collectMarkers` returned for the flags actually passed; `diagnostics` is the
 *  same errors-only list text mode still prints (`em validate` fails the run on genuine
 *  errors regardless of which `--list-*` flag was passed). */
export function buildValidateListJson(file: string, markers: MarkerEntry[], diagnostics: Diagnostic[]): string {
  const doc = {
    validateListSchemaVersion: VALIDATE_LIST_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    markers,
    diagnostics: diagnostics.map(serializeDiagnosticWithUsage),
  };
  return JSON.stringify(doc, null, 2);
}
