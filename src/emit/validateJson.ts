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

import { Diagnostic, serializeDiagnostic, publicViewsWithoutInModelReader } from "../model/validate.js";
import { RULES, RuleCode } from "../model/rules.js";
import { Element, NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { SliceReadyGates } from "../catalog/sliceReadyValidate.js";
import type { ShapeReport } from "../cli/shape.js";
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
// 1.1 (MIL-208): `continuationOf` — non-null when `sliceKey` names a continuation slice (an
// again-view-only slice with no legacy doc of its own), naming the originating slice whose doc
// the `gates` above actually verify. `gates` themselves already resolve straight through to the
// originating slice's own doc/status (see `computeSliceReadyGates`); this field only explains
// why. Additive-only.
// 1.2 (MIL-259, 1.14.0): `gates.ratified` — the doc carries a recorded `ratifiedBy`. A
// ready-to-implement doc without one (e.g. right after `em slice reratify`) is no longer ready:
// the `slice-ready-not-ratified` error joins the scoped diagnostics. Additive-only.
//  - MIL-266: `slice-ready-structured-section-malformed` (error) can join the scoped diagnostics
//    — a doc whose generated regions or `### Scenario:` blocks don't parse. Diagnostic-only:
//    `gates` is unchanged.
// 1.3 (GH #260, 1.17.0): top-level `reviewSkipped: string | null` — the status `em slice ratify
// --skip-review` ratified from when that bypass is what let the ratification through; null for a
// reviewed ratification, a doc predating 1.17, an unusable doc, or an unknown slice. Informational
// (not a gate): a host decides whether an unreviewed ratification passes. Additive-only.
// 1.4 (GH #293, 1.18.0): top-level `advisories: Diagnostic[]` — diagnostics of advisory rules
// (RuleDef.advisory, e.g. the scenario-quality warnings) concerning this slice. They are listed
// but never gate `ready`; under `--strict` they are promoted into `diagnostics` as errors and
// `advisories` is empty. Additive-only.
export const VALIDATE_SLICE_READY_SCHEMA_VERSION = "1.4";

/** Build the `em validate <file> --slice-ready <key> --json` document — the machine verdict
 *  replacing the two hand-parsed English sentences ("is ready-to-implement" /
 *  "is NOT ready-to-implement") plus scraped warning prose. `gates` names each of the 5
 *  conditions individually (see `computeSliceReadyGates`, catalog/sliceReadyValidate.ts);
 *  `null` when `sliceKey` matches no slice in the model (the `slice-ready-unknown-slice` error
 *  case — nothing to gate). `ready` is the same predicate driving `em validate`'s exit code
 *  for `--slice-ready` (no error-severity scoped diagnostics and no warning whose code is in the
 *  gating list of GH #332, see docs/cli.md; any other warning is listed in `diagnostics` but never
 *  flips it) — it is the AND of the gates only when `gates` is non-null AND nothing gating
 *  remains (e.g. a `both-ends-of-a-flow/*` warning on one of its own elements); `diagnostics` carries that full
 *  scoped list so a consumer sees exactly why, never just the 4 named gates. `continuationOf`
 *  (MIL-208) is `null` for an ordinary slice or when `gates` is `null`. */
export function buildSliceReadyJson(
  file: string,
  sliceKey: string,
  gates: SliceReadyGates | null,
  diagnostics: Diagnostic[],
  ready: boolean,
  continuationOf: string | null,
  reviewSkipped: string | null = null,
  advisories: Diagnostic[] = [],
): string {
  const doc = {
    validateSliceReadySchemaVersion: VALIDATE_SLICE_READY_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    sliceKey,
    gates,
    continuationOf,
    reviewSkipped,
    ready,
    diagnostics: diagnostics.map(serializeDiagnosticWithUsage),
    advisories: advisories.map(serializeDiagnosticWithUsage),
  };
  return JSON.stringify(doc, null, 2);
}

// 1.0 (MIL-128): initial shape.
// 1.1 (MIL-215): `noInModelReader` on `public` markers — true for a `view` no `ui`/reaction
// reads anywhere on its timeline, false for one that is read, `null` for `event` markers and
// every `issue`/`divergence` marker (the signal only applies to views). Additive-only.
export const VALIDATE_LIST_SCHEMA_VERSION = "1.1";

/** One `--list-issues`/`--list-divergences`/`--list-public` entry — the structured replacement
 *  for the `  issue :12 slice "X" command "Y": text` eyeball format. `elementRef` is the same
 *  export-stable ref (`<sliceKey>/<kind>.<slug>`) `em export`/`em diff` use — never a second
 *  identifier scheme. `text` is the `issue`/`divergence` annotation's own text; `null` for a
 *  `public` marker, which carries no text. `noInModelReader` (MIL-215) is the `--list-public`
 *  audit note ("no in-model reader") for a `public` `view` marker — see
 *  `publicViewsWithoutInModelReader` (model/validate.ts) for why this is an audit annotation,
 *  not a validate warning; `null` for an `event` marker or any `issue`/`divergence` marker. */
export interface MarkerEntry {
  markerKind: "issue" | "divergence" | "public";
  sliceKey: string;
  sliceName: string;
  elementRef: string;
  elementKind: string;
  elementName: string;
  text: string | null;
  noInModelReader: boolean | null;
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
  const entryFor = (
    el: Element,
    markerKind: MarkerEntry["markerKind"],
    text: string | null,
    noInModelReader: boolean | null = null,
  ): MarkerEntry => ({
    markerKind,
    sliceKey: refs.sliceKeys[el.sliceIndex],
    sliceName: model.slices[el.sliceIndex].name,
    elementRef: refs.refById.get(el.id)!,
    elementKind: el.kind,
    elementName: el.name,
    text,
    noInModelReader,
    line: el.line,
  });
  if (kinds.issues) {
    for (const el of model.elements) if (el.issue) markers.push(entryFor(el, "issue", el.issue));
  }
  if (kinds.divergences) {
    for (const el of model.elements) if (el.divergence) markers.push(entryFor(el, "divergence", el.divergence));
  }
  if (kinds.public) {
    const noReader = publicViewsWithoutInModelReader(model);
    for (const el of model.elements) {
      if (el.public && (el.kind === "command" || el.kind === "event" || el.kind === "view")) {
        const flag = el.kind === "view" ? noReader.has(el.logicalId) : null;
        markers.push(entryFor(el, "public", null, flag));
      }
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

// 1.0 (GH #282): initial shape — `em validate --shape --json`. `rules[]` carries every shape-family
// rule (zero-count ones too, so a consumer sees what was checked), each with its `findings` (the
// diagnostics that count: message, line, refs) and `waived` (excused by `--waive-file`, never
// counted). `summary.findings` / `summary.waived` total them; `clean` is `summary.findings === 0`.
// `staleWaivers` lists waive-file lines that excused nothing (stale key or unknown rule code).
// `modelErrors` is the count of error diagnostics elsewhere in the model (shape output is
// incomplete while it is non-zero). Advisory: the exit code is 0 whatever the content.
export const VALIDATE_SHAPE_SCHEMA_VERSION = "1.0";

export function buildShapeJson(file: string, report: ShapeReport, modelErrors: number): string {
  const ser = (d: Diagnostic) => ({ message: d.message, line: d.line ?? null, refs: d.refs ?? [] });
  const doc = {
    shapeSchemaVersion: VALIDATE_SHAPE_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    clean: report.findings === 0,
    modelErrors,
    summary: { findings: report.findings, waived: report.waived, rules: report.rules.length },
    staleWaivers: report.staleWaivers,
    rules: report.rules.map((r) => ({
      code: r.code,
      title: r.title,
      docAnchor: r.docAnchor,
      count: r.findings.length,
      findings: r.findings.map(ser),
      waived: r.waived.map(ser),
    })),
  };
  return JSON.stringify(doc, null, 2);
}
