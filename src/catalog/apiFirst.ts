// SPDX-License-Identifier: MIT
// The API-first design exit gate (MIL-238, briefing R10): the two facts `em validate
// --slice-ready`, `em slice ratify`/`reratify` and `em status` all share.
//
//  - "public-touching slice": a slice owning at least one `public` command, event or view —
//    the elements `em api generate` puts on the model's contract (emit/api.ts).
//  - "contract current": `<modelDir>/contracts/<modelKey>.tsp` exists and its text equals what
//    `em api generate` would write from the current model. A plain text comparison (R12): the
//    generated header carries no source hash, so an internal-only `.em` edit never makes the
//    contract stale. Generation reuses `generateContract` (src/cli/api.ts) in-process — the same
//    builder `em api generate`/`em api check` call, never a shell-out.

import { existsSync, readFileSync } from "node:fs";
import { NormalizedModel, Slice } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { contractPathFor, generateContract } from "../cli/api.js";

const CONTRACT_KINDS: ReadonlySet<string> = new Set(["command", "event", "view"]);

/** True when `slice` owns at least one `public` command, event or view. */
export function slicePublicTouching(slice: Slice): boolean {
  return slice.elements.some((el) => el.public === true && CONTRACT_KINDS.has(el.kind));
}

/** `slicePublicTouching` by export key; false for an unknown key. */
export function isPublicTouchingSlice(model: NormalizedModel, refs: RefsResult, sliceKey: string): boolean {
  const i = refs.sliceKeys.indexOf(sliceKey);
  return i !== -1 && slicePublicTouching(model.slices[i]);
}

/** What the contract-currency check needs beyond the compiled model: the `.em` path as the
 *  caller was given it (the contract path is built from it, as `em api generate` does), its
 *  source text, and the compile diagnostics. */
export interface ContractCheckInput {
  file: string;
  source: string;
  diagnostics: Diagnostic[];
}

export type ContractState = "current" | "missing" | "stale";

export interface ContractStatus {
  state: ContractState;
  /** The contract path, built from `file` exactly as `em api generate` builds it. */
  contractPath: string;
}

/**
 * Is the committed contract current? `missing` when the file does not exist; `stale` when its
 * text differs from the freshly generated text — or when the model cannot be generated from at
 * all (a public field with no resolvable type raises `public-field-type-unresolved`, which
 * `em api generate` refuses on; the contract cannot be current then either).
 */
export function contractStatus(model: NormalizedModel, refs: RefsResult, input: ContractCheckInput): ContractStatus {
  // generateContract reads only model/refs/diagnostics from its compile argument.
  const compiled = { model, refs, diagnostics: input.diagnostics } as unknown as Parameters<typeof generateContract>[2];
  let generated: ReturnType<typeof generateContract>;
  try {
    generated = generateContract(input.file, input.source, compiled);
  } catch {
    // Generation needs a resolvable public type per field; without one the contract can't be
    // regenerated, so it can't be current. Path is still the conventional one.
    const fallback = contractPathFor(input.file, computeModelKey(model, input.file));
    return { state: existsSync(fallback) ? "stale" : "missing", contractPath: fallback };
  }
  if (!existsSync(generated.contractPath)) return { state: "missing", contractPath: generated.contractPath };
  const committed = readFileSync(generated.contractPath, "utf8");
  return { state: committed === generated.text ? "current" : "stale", contractPath: generated.contractPath };
}

