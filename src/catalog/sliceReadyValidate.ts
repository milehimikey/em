// SPDX-License-Identifier: MIT
// `em validate --slice-ready <key>` (MIL-87): the handoff gate without the bridge. Gives em
// itself a native version of the readiness check that used to live only in em-sdd-bridge's
// `assertReadyToImplement` — status: ready-to-implement AND every Open Question checked —
// so any toolchain reading slice docs directly (not just ones routed through the bridge) has
// a gate to enforce.
//
// Deliberately single-slice, opt-in — unlike catalog/lineageValidate.ts (MIL-84) and
// catalog/frontmatterCoherenceValidate.ts (MIL-85), which run unconditionally on every
// `em validate` because they only fire on genuine anomalies. "Not yet ready-to-implement" /
// "has unchecked Open Questions" is the NORMAL state of most slices most of the time (drafts,
// reviewed-but-not-ready-yet, ...) — splicing this into the unconditional diagnostic set would
// make plain `em validate` permanently noisy on any healthy in-progress model. So this only
// ever runs for the one slice named by `--slice-ready <key>`.
//
// "Note binding" (the ticket's own phrase) means reusing docJoin.ts's resolveSliceDocJoin — the
// same note-gated resolution `em export` (MIL-91) uses — rather than the filename-only
// readSliceDoc/existsSync convention `em catalog`/`em render` deliberately use instead (that
// convention has a tested invariant of ignoring `note` entirely; this module doesn't touch it).
// A slice with no `note "slices/<key>.md"` element bound to it isn't ready by definition: there's
// nothing ratified to check status/Open Questions against.
//
// version/status/link coherence (MIL-85) is folded in for free at the CLI layer (src/cli.ts):
// validateFrontmatterCoherence already runs unconditionally and already tags its diagnostics
// with `refs: [sliceKey]`, so the `--slice-ready` branch filters the full combined diagnostic
// set by that ref instead of this module re-deriving classifyImplementationDrift.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceKey } from "../model/resolveSlice.js";
import { Diagnostic } from "../model/validate.js";
import { makeDiag, pushDiag, RULES } from "../model/rules.js";
import { resolveSliceDocJoin } from "./docJoin.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { ratifiedHashScope } from "./sliceDoc.js";
import { findStructuredSectionProblems } from "./sliceSections.js";
import { ContractCheckInput, contractStatus, slicePublicTouching } from "./apiFirst.js";
import { isGrandfatheredSignoff, loadRoster, rosterRefusal, sliceContexts } from "../roster/roster.js";
import { rosterContextFor } from "../roster/context.js";
import { computeModelKey } from "../model/qualifiedRef.js";

export type { ContractCheckInput } from "./apiFirst.js";

/** MIL-238 (briefing R10): the API-first gate's diagnostic for one slice, or null when the slice
 *  touches no public element or its model's contract is current. Independent of the slice doc —
 *  the contract belongs to the model — so it is appended on every path past the unknown-key check. */
function contractStaleDiagnostic(
  model: NormalizedModel,
  refs: RefsResult,
  sliceIndex: number,
  sliceKey: string,
  contract: ContractCheckInput,
): Diagnostic | null {
  const slice = model.slices[sliceIndex];
  if (!slicePublicTouching(slice)) return null;
  const { state, contractPath } = contractStatus(model, refs, contract);
  if (state === "current") return null;
  return makeDiag("slice-ready-contract-stale", {
    message:
      `slice "${sliceKey}" touches the public surface but the contract ${contractPath} is ${state} — ` +
      `run: em api generate ${contract.file}`,
    line: slice.line,
    refs: [sliceKey],
  });
}

/** GH #237: the resolver's own words for an input that names no slice (the valid keys, or an ambiguity). */
function resolveSliceMessage(model: NormalizedModel, refs: RefsResult, sliceKey: string): string {
  const r = resolveSliceKey(model, refs, sliceKey);
  return r.ok ? `no slice with export key "${sliceKey}" in this model` : r.message;
}

/**
 * Readiness gate for one slice, named by its export key (`refs.sliceKeys`). `baseDir` is the
 * `.em` file's directory, same convention every other doc/note path in em uses. Always warning-
 * severity (fits validate's existing warning-producer shape) except for a bad `sliceKey` itself,
 * which is an error — a CLI-argument mistake, not a model-quality finding. The `--slice-ready`
 * flag in src/cli.ts is what decides whether these warnings gate the exit code.
 *
 * MIL-238: `contract` (the `.em` path as given, its source and compile diagnostics) feeds the
 * API-first gate — a public-touching slice whose model contract is missing or stale gets a
 * `slice-ready-contract-stale` error on every path past the unknown-key check.
 */
/** GH #256: the opt-in strictness a host turns on once its legacy docs are re-ratified. */
export interface SliceReadyOptions {
  /** `--require-ratified-hash`: a `ready-to-implement` doc with no `ratifiedHash:` is NOT ready
   *  (`slice-ready-missing-ratified-hash`, error). Off by default so docs ratified before em 1.15
   *  — and `em upgrade`'s grandfathered sign-offs — keep passing; a hand-edited frontmatter that
   *  fakes `ratifiedBy`/`ratifiedOn` without a hash passes readiness with no integrity check
   *  otherwise, which is the hole this closes. */
  requireRatifiedHash?: boolean;
  /** `--strict` (GH #293): advisory-rule diagnostics (RuleDef.advisory) are promoted to errors and gate. */
  strict?: boolean;
  /** GH #259: explicit roster path (`--roster`); omitted = the nearest `ratifiers.yaml` above the model. */
  rosterPath?: string;
}

export function validateSliceReady(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  contract: ContractCheckInput,
  options: SliceReadyOptions = {},
): Diagnostic[] {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return [
      makeDiag("slice-ready-unknown-slice", {
        message: resolveSliceMessage(model, refs, sliceKey),
        refs: [sliceKey],
      }),
    ];
  }
  const slice = model.slices[sliceIndex];
  const contractDiag = contractStaleDiagnostic(model, refs, sliceIndex, sliceKey, contract);
  const withContract = (diags: Diagnostic[]): Diagnostic[] => (contractDiag ? [...diags, contractDiag] : diags);
  const { doc, diagnostics: joinDiagnostics } = resolveSliceDocJoin(
    model,
    refs,
    slice,
    sliceKey,
    baseDir,
    (id) => refs.refById.get(id)!,
  );

  if (doc.reason === "no-doc-bound") {
    return withContract([
      makeDiag("slice-ready-no-doc-bound", {
        message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before it can be ready-to-implement`,
        line: slice.line,
        refs: [sliceKey],
      }),
    ]);
  }
  if (doc.reason === "binding-missing-file" || doc.reason === "frontmatter-invalid") {
    // Reuse docJoin's own diagnostics verbatim — don't re-code binding-missing-file/
    // frontmatter-invalid a second time under a slice-ready-specific code.
    return withContract(joinDiagnostics);
  }

  // doc.reason === null: found, usable frontmatter.
  const diags: Diagnostic[] = [];
  if (doc.status !== "ready-to-implement") {
    pushDiag(diags, "slice-ready-status-not-ready", {
      message: `slice "${sliceKey}" is status: ${doc.status ?? "(none)"}, not ready-to-implement`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  // MIL-259: a ready-to-implement doc must carry a recorded sign-off. `em slice reratify`
  // clears `ratifiedBy` and bumps `version`, leaving `status: ready-to-implement` in place until
  // someone re-signs — without this check that unsigned state read as ready. Only checked when
  // the status IS ready-to-implement: any other status already blocks via the diagnostic above,
  // and a second "not ratified" finding there would just be noise.
  if (doc.status === "ready-to-implement" && !doc.ratifiedBy) {
    pushDiag(diags, "slice-ready-not-ratified", {
      message: `slice "${sliceKey}" is ready-to-implement but carries no ratifiedBy — record the sign-off with \`em slice ratify --by <name>\``,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  // resolveSliceDocJoin's SliceDocExport deliberately never carries Open Questions counts (same
  // hard boundary that keeps doc.html/doc.raw out of it) — re-read via readSliceDoc for the
  // full SliceDoc. Non-null: doc.reason === null already implies the file exists and parses.
  // Re-derive the key to read from `doc.path` rather than assuming it's `sliceKey`'s own
  // conventional path — MIL-121's ratified cross-binding can resolve `doc` to a DIFFERENT
  // slice's doc (`slices/<other-key>.md`), and Open Questions must come from whichever doc
  // actually supplied status/version above, not always this slice's own file.
  const boundKey = doc.path.replace(/^slices\//, "").replace(/\.md$/, "");
  const parsed = readSliceDoc(baseDir, boundKey)!;

  // MIL-284: the ratified body has an identity now. A doc whose body moved after `em slice
  // ratify` recorded `ratifiedHash:` is not the spec that was signed — the ratification stands
  // on content that is gone. Only checked when a hash exists (a doc ratified before em 1.15 has
  // none and is judged on `ratifiedBy` alone, as before) and only at ready-to-implement. A hash
  // in the pre-1.17 whole-body scope still passes (GH #253: `legacy` is intact, not edited).
  if (doc.status === "ready-to-implement" && doc.ratifiedHash !== null && ratifiedHashScope(parsed.raw, doc.ratifiedHash) === "mismatch") {
    pushDiag(diags, "slice-ready-body-changed-since-ratification", {
      message: `slice "${sliceKey}"'s doc ${doc.path} was edited after ratification (body no longer matches ratifiedHash) — revert, or re-ratify the new content`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  // GH #259: with a ratifier roster present, a `ratifiedBy` it does not permit for this slice's
  // context — the hand-edited-frontmatter case `em slice ratify`'s own refusal cannot see.
  // `grandfathered ...` is em's own migration marker, not a signer, so it is exempt (it stays a
  // finding of --require-ratified-hash and a human re-ratify item). Only `ready-to-implement`
  // docs are checked here; `em roster check` also covers shipped docs.
  if (doc.status === "ready-to-implement" && doc.ratifiedBy && !isGrandfatheredSignoff(doc.ratifiedBy)) {
    const roster = loadRoster(baseDir, options.rosterPath, rosterContextFor(model, contract.file));
    if (roster.state === "invalid") {
      for (const d of roster.diagnostics) {
        pushDiag(diags, "roster-invalid", { message: `${roster.path}: ${d.message}`, line: slice.line, refs: [sliceKey] });
      }
    } else if (roster.state === "present") {
      const why = rosterRefusal(roster.roster, "ratifiers", doc.ratifiedBy, sliceContexts(model, sliceIndex), computeModelKey(model, contract.file));
      if (why !== null) {
        pushDiag(diags, "ratified-by-not-in-roster", {
          message: `slice "${sliceKey}": ratifiedBy ${why} (${roster.path}) — re-ratify with a permitted name, or update the roster`,
          line: slice.line,
          refs: [sliceKey],
        });
      }
    }
  }

  // GH #256: strict mode — the body-changed check above can only run when a hash exists, so
  // without this a `ready-to-implement` doc whose frontmatter was hand-edited to carry
  // `ratifiedBy`/`ratifiedOn` and no `ratifiedHash` passes with no integrity check at all.
  if (options.requireRatifiedHash && doc.status === "ready-to-implement" && doc.ratifiedHash === null) {
    pushDiag(diags, "slice-ready-missing-ratified-hash", {
      message: `slice "${sliceKey}"'s doc ${doc.path} is ready-to-implement with no ratifiedHash — --require-ratified-hash is on: re-ratify it (\`em slice revise --withdraw\`, review, \`em slice ratify --by\`) so the signed body has an identity`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  if (parsed.openQuestionsUnchecked > 0) {
    pushDiag(diags, "slice-ready-open-questions-unchecked", {
      message: `slice "${sliceKey}" has ${parsed.openQuestionsUnchecked} of ${parsed.openQuestionsTotal} Open Question(s) unchecked`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  // MIL-266: the `--slice-ready` twin of `slice-doc/structured-section-malformed` — a generated
  // region whose markers don't balance or whose table header drifted from the template, or a
  // `### Scenario:` block missing Given/When/Then, is not a spec an implementer can read
  // mechanically. Diagnostic-only blocker: `gates` gains no boolean (the scoped diagnostics are
  // what drive `ready`). Silent on a doc with no markers and no `### Scenario:` heading.
  for (const problem of findStructuredSectionProblems(parsed.body)) {
    pushDiag(diags, "slice-ready-structured-section-malformed", {
      message: `slice "${sliceKey}"'s doc ${doc.path}: ${problem}`,
      line: slice.line,
      refs: [sliceKey],
    });
  }

  return withContract(diags);
}

/** The named gate conditions `em validate --slice-ready <key> --json` reports individually
 *  (MIL-128; 4 originally, `ratified` MIL-259, `contractCurrent` MIL-238): doc bound, frontmatter usable, status ready-to-implement, no unchecked Open
 *  Questions — the exact facts `validateSliceReady` above already derives from the same doc
 *  join and parse, exposed as independent pass/fail booleans instead of collapsed into
 *  short-circuited diagnostics, so a JSON consumer sees exactly which gate(s) failed without
 *  re-deriving anything or parsing prose. `null` when `sliceKey` names no slice in the model —
 *  mirrors `slice-ready-unknown-slice`'s error case, which has no gates to report. A gate not
 *  reached because an earlier one failed (e.g. status/open-questions when the doc itself isn't
 *  usable) reports `false`, not `null` — "not confirmed ready" either way, and consistent with
 *  the overall verdict being the AND of all four. No new judgment: same reads, same rules,
 *  reshaped for direct consumption instead of scraped from stderr prose. */
export interface SliceReadyGates {
  docBound: boolean;
  frontmatterUsable: boolean;
  statusReady: boolean;
  noUncheckedOpenQuestions: boolean;
  /** MIL-259: the doc carries a non-empty `ratifiedBy` (the recorded sign-off for its current
   *  version). Only meaningful alongside `statusReady`; `false` whenever the doc is unusable. */
  ratified: boolean;
  /** MIL-238: the API-first gate — `true` when the slice touches no public element, or when its
   *  model's `contracts/<modelKey>.tsp` exists and equals the freshly generated text. Computed
   *  from the model, not the doc, so it is reported truthfully even when the doc is unusable. */
  contractCurrent: boolean;
}

/** `computeSliceReadyGates`'s full result (MIL-208): the 4 gates plus `continuationOf` — non-
 *  null when `sliceKey` names a continuation slice (an again-view-only slice with no legacy doc
 *  of its own), naming the originating slice whose doc/status the gates above actually verify.
 *  `gates` themselves already reflect the originating slice's verdict transparently (the same
 *  `resolveSliceDocJoin()` call this function makes resolves straight through) — this field
 *  only explains WHY, the same "doc reports the real status, continuationOf says why" split
 *  `em export` uses. */
export interface SliceReadyResult {
  gates: SliceReadyGates;
  continuationOf: string | null;
  /** GH #260: the doc's `reviewSkipped:` — the status `em slice ratify --skip-review` ratified
   *  from when that bypass is what let it through; null otherwise (and when the doc is unusable).
   *  Informational, never a gate: a host decides whether an unreviewed ratification passes. */
  reviewSkipped: string | null;
}

export function computeSliceReadyGates(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  contract: ContractCheckInput,
): SliceReadyResult | null {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) return null;
  const slice = model.slices[sliceIndex];
  const contractCurrent = !slicePublicTouching(slice) || contractStatus(model, refs, contract).state === "current";
  const { doc, continuationOf } = resolveSliceDocJoin(model, refs, slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);

  const docBound = doc.reason !== "no-doc-bound";
  const frontmatterUsable = doc.reason === null;
  if (!frontmatterUsable) {
    return { gates: { docBound, frontmatterUsable, statusReady: false, noUncheckedOpenQuestions: false, ratified: false, contractCurrent }, continuationOf, reviewSkipped: null };
  }

  const statusReady = doc.status === "ready-to-implement";
  // Same re-derivation of the bound key from doc.path as validateSliceReady above — see its
  // own comment for why (MIL-121 cross-binding can resolve to a different slice's doc).
  const boundKey = doc.path.replace(/^slices\//, "").replace(/\.md$/, "");
  const parsed = readSliceDoc(baseDir, boundKey)!;
  const noUncheckedOpenQuestions = parsed.openQuestionsUnchecked === 0;

  const ratified = !!doc.ratifiedBy;

  return { gates: { docBound, frontmatterUsable, statusReady, noUncheckedOpenQuestions, ratified, contractCurrent }, continuationOf, reviewSkipped: doc.reviewSkipped };
}

/** R34 (MIL-268): the full `--slice-ready` verdict for one slice — the ONE computation `em
 *  validate --slice-ready`, the MCP `slice_ready` tool, and `em engagement plan` all call, so
 *  "ready" can never mean three slightly different things. `allDiagnostics` is the caller's
 *  unconditional `em validate` diagnostic set (compile + fs-aware checks); this adds the opt-in
 *  readiness diagnostics, keeps only those concerning THIS slice (a ref that is the bare key or
 *  starts with `<key>/` — an unrelated slice's breakage never blocks it), and derives `ready` as
 *  "no scoped diagnostics". `result` is `computeSliceReadyGates`' named gates (null for an
 *  unknown key). */
export interface SliceReadiness {
  /** Blocking diagnostics concerning this slice — what `ready` is derived from. */
  scoped: Diagnostic[];
  /** GH #293: advisory-rule diagnostics concerning this slice (listed, never gating). Empty under
   *  `strict`, which promotes them into `scoped` as errors. */
  advisories: Diagnostic[];
  ready: boolean;
  result: SliceReadyResult | null;
}

export function computeSliceReadiness(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  contract: ContractCheckInput,
  allDiagnostics: Diagnostic[],
  options: SliceReadyOptions = {},
): SliceReadiness {
  const readyDiagnostics = validateSliceReady(model, refs, baseDir, sliceKey, contract, options);
  const combined = [...allDiagnostics, ...readyDiagnostics];
  const concerning = combined.filter((d) => d.refs?.some((r) => r === sliceKey || r.startsWith(`${sliceKey}/`)));
  const isAdvisory = (d: Diagnostic): boolean => (RULES as Record<string, { advisory?: true }>)[d.code]?.advisory === true;
  const strict = options.strict === true;
  const scoped = concerning
    .filter((d) => strict || !isAdvisory(d))
    .map((d) => (strict && isAdvisory(d) ? { ...d, severity: "error" as const } : d));
  const advisories = strict ? [] : concerning.filter(isAdvisory);
  const result = computeSliceReadyGates(model, refs, baseDir, sliceKey, contract);
  return { scoped, advisories, ready: scoped.length === 0, result };
}
