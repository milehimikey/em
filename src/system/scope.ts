// SPDX-License-Identifier: MIT
// `em system scope` (MIL-240): the pure half. Given each model's directory, its contract file,
// the structural public-surface changes between the base revision and HEAD, and both sides'
// `consumes` bindings, plus the change set's repo-relative paths, return the findings:
//
//   seam-crossing (error)             a producer's public surface or contract file changed AND a
//                                     model that consumes it changed its design dir, in ONE change set
//   seam-crossing-greenfield (warn)   the only "surface changes" are elements no consumer was bound
//                                     to at the base revision (new public surface) - not a crossing
//   multi-model-change-set (warn)     the change set touches >= 2 model dirs and crosses no contract
//   code-spans-seam (warn)            advisory: code under two seam-joined models' declared code roots
//
// There is NO override: review on the contract file (CODEOWNERS, MIL-234) is the override.
//
// Pure: no git, no fs, no compile. `src/cli/scopeInputs.ts` gathers the inputs; the same function
// runs per commit for `em metrics`' `seamCrossings`.

import type { ApiCheckChange } from "../cli/api.js";
import { makeDiag, RuleCode } from "../model/rules.js";
import { parseContractRef } from "../model/qualifiedRef.js";
import type { SystemDiagnostic } from "./verify.js";

export interface ScopeModel {
  key: string;
  /** Repo-root-relative model file, `/`-separated. */
  file: string;
  /** Repo-root-relative model directory (`dirname(file)`; "" when the model sits at the repo root). */
  dir: string;
  /** Repo-root-relative contract file: `<dir>/contracts/<key>.tsp` (briefing R6). */
  contract: string;
  /** Repo-root-relative code roots the model's state file declares (`Code roots:` bullet); [] when none. */
  codeRoots: string[];
  /** Structural public-surface changes base -> HEAD (`diffSurfaces`). `null` = not evaluated: the
   *  model file is unchanged or exempt in this change set. A model absent at base reports every
   *  public element as additive "added". */
  surfaceChanges: ApiCheckChange[] | null;
  /** `<modelKey>:<kind>.<slug>` refs this model's translations consume, at HEAD and at base. */
  headConsumes: string[];
  baseConsumes: string[];
}

export interface ScopeInput {
  models: ScopeModel[];
  /** Repo-relative changed paths AFTER the `Em-Upgrade:` exemption: both sides of a rename. */
  changed: string[];
}

export interface ScopeTouched {
  key: string;
  dir: string;
  /** Changed paths under this model's dir (longest-prefix match), sorted. */
  paths: string[];
}

export interface ScopeReport {
  /** Models whose design dir has >= 1 changed path, sorted by key. */
  touched: ScopeTouched[];
  /** Changed paths under no model dir (ignored), sorted. */
  unmapped: string[];
  diagnostics: SystemDiagnostic[];
  /** Number of `seam-crossing` errors. */
  crossings: number;
}

const isUnder = (path: string, dir: string): boolean => dir === "" || path === dir || path.startsWith(dir + "/");

/** Longest-prefix model for a path (briefing R6); `null` outside every model dir. */
export function modelForPath(models: Pick<ScopeModel, "key" | "dir">[], path: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const m of models) {
    if (!isUnder(path, m.dir)) continue;
    if (best === null || m.dir.length > best.len) best = { key: m.key, len: m.dir.length };
  }
  return best === null ? null : best.key;
}

/** `Code roots:` bullet from a model's `.event-modeling.md`: `- **Code roots:** a, b` (comma
 *  separated, repo-root-relative). `[]` when absent or `none`. */
export function parseCodeRoots(stateText: string): string[] {
  const m = /^-\s+\*\*Code roots:\*\*\s*(.*)$/m.exec(stateText);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((s) => s !== "" && s.toLowerCase() !== "none");
}

function consumedModels(m: ScopeModel): Set<string> {
  const out = new Set<string>();
  for (const ref of [...m.headConsumes, ...m.baseConsumes]) {
    const p = parseContractRef(ref);
    if (p) out.add(p.modelKey);
  }
  return out;
}

function diag(file: string, code: RuleCode, message: string, refs: string[]): SystemDiagnostic {
  return { file, ...makeDiag(code, { message, refs }) };
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function evaluateScope(input: ScopeInput): ScopeReport {
  const models = [...input.models].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byModel = new Map<string, string[]>();
  const unmapped: string[] = [];
  for (const p of [...input.changed].sort()) {
    const key = modelForPath(models, p);
    if (key === null) unmapped.push(p);
    else byModel.set(key, [...(byModel.get(key) ?? []), p]);
  }
  const touched: ScopeTouched[] = models
    .filter((m) => byModel.has(m.key))
    .map((m) => ({ key: m.key, dir: m.dir, paths: byModel.get(m.key)! }));
  const changedSet = new Set(input.changed);

  // Consumers per producer, from either side of the change (a removed `consumes` still counts).
  const consumes = new Map(models.map((m) => [m.key, consumedModels(m)]));
  const boundAtBase = new Set(models.flatMap((m) => m.baseConsumes));

  const diagnostics: SystemDiagnostic[] = [];
  let crossings = 0;

  for (const producer of models) {
    const surface = producer.surfaceChanges ?? [];
    const contractChanged = changedSet.has(producer.contract);
    if (surface.length === 0 && !contractChanged) continue;

    // New public surface nothing was bound to at base is greenfield (not a crossing).
    const isGreenfield = (c: ApiCheckChange): boolean =>
      c.field === null && (c.what === "added" || c.what === "marked public") && !boundAtBase.has(`${producer.key}:${c.element}`);
    const greenfield = surface.filter(isGreenfield);
    const binding = surface.filter((c) => !isGreenfield(c));
    // A changed contract file is explained by greenfield-only surface changes (it was regenerated);
    // it is a trigger of its own only when nothing in the surface accounts for it.
    const contractTrigger = contractChanged && surface.length === 0;
    const triggered = binding.length > 0 || contractTrigger;

    const consumers = models.filter((c) => c.key !== producer.key && (consumes.get(c.key)?.has(producer.key) ?? false) && byModel.has(c.key));

    if (!triggered) {
      if (greenfield.length > 0 && consumers.length > 0) {
        const els = sorted(greenfield.map((c) => c.element));
        diagnostics.push(
          diag(
            producer.file,
            "seam-crossing-greenfield",
            `${producer.key}: ${els.join(", ")} ${els.length === 1 ? "is" : "are"} new public surface with no consumer bound at the base revision, ` +
              `changed together with ${consumers.map((c) => c.key).join(", ")} - not a crossing (greenfield); later changes to ${els.length === 1 ? "it" : "them"} are`,
            [...els.map((e) => `${producer.key}:${e}`), ...consumers.map((c) => c.key)],
          ),
        );
      }
      continue;
    }

    const what: string[] = sorted(binding.map((c) => `${c.element}${c.field !== null ? ` field "${c.field}"` : ""} ${c.what}`));
    if (contractTrigger) what.push(`contract file ${producer.contract} changed`);
    const elementRefs = sorted(binding.map((c) => `${producer.key}:${c.element}`));
    if (contractTrigger) elementRefs.push(`${producer.key}:contract`);

    for (const consumer of consumers) {
      crossings++;
      const paths = byModel.get(consumer.key)!;
      diagnostics.push(
        diag(
          producer.file,
          "seam-crossing",
          `change set alters ${producer.key}'s public surface (${what.join("; ")}) and ${consumer.key}, which consumes it ` +
            `(changed: ${paths.join(", ")}) - land the contract change and the consumer's adaptation in separate change sets; ` +
            `review on ${producer.contract} is the only override`,
          [...elementRefs, consumer.key],
        ),
      );
    }
  }

  if (crossings === 0 && touched.length >= 2) {
    const keys = touched.map((t) => t.key);
    diagnostics.push(
      diag(".", "multi-model-change-set", `change set touches ${keys.length} models (${keys.join(", ")}) but crosses no contract - consider one change set per model`, keys),
    );
  }

  // Advisory code-side check: changed code under two seam-joined models' declared code roots.
  const underRoots = (m: ScopeModel): string[] => sorted(input.changed.filter((p) => m.codeRoots.some((r) => isUnder(p, r))));
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i];
      const b = models[j];
      if (!(consumes.get(a.key)?.has(b.key) || consumes.get(b.key)?.has(a.key))) continue;
      const pa = underRoots(a);
      const pb = underRoots(b);
      if (pa.length === 0 || pb.length === 0) continue;
      diagnostics.push(
        diag(
          a.file,
          "code-spans-seam",
          `code change spans the seam between ${a.key} (${pa.join(", ")}) and ${b.key} (${pb.join(", ")}) - one code module per model, changed in separate change sets`,
          [a.key, b.key],
        ),
      );
    }
  }

  return { touched, unmapped, diagnostics, crossings };
}
