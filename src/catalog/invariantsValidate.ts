// SPDX-License-Identifier: MIT
// `em validate`'s fs-aware invariant advisories (MIL-265): the three `invariants/*` warnings that
// compare the model's declared invariants (`invariant INV-<MNEMONIC>-<n> "rule"` lines,
// model/model.ts `collectModelInvariants`) with the slice docs' bodies. Same fs-aware-sibling
// shape as catalog/docModelConsistencyValidate.ts: a module next to model/validate.ts because it
// reads `baseDir`; the two model-only ID errors (`invariants/malformed-id`/`duplicate-id`) live in
// model/validate.ts itself.
//
// Additive by construction: `public-command-without-invariants` needs a `public` command and
// `declared-in-both` needs a model-declared id, neither of which a 1.13 model can have. Only
// `doc-cites-undeclared` can fire on 1.13 content, and it carries NO slice-key ref on purpose —
// `--slice-ready` treats every diagnostic scoped to the slice as a blocker (src/cli.ts, the MCP
// `slice_ready` tool), so a slice-key ref would turn a 1.13 doc that passed the gate into one
// that fails it. The message names the doc and its slice instead. `declared-in-both` is the
// ticket's "hint" (Diagnostic has no severity below warning) and likewise carries no ref, so a
// half-finished migration never blocks `--slice-ready`.
//
// Doc reads go through model/sliceDocIndex.ts (one `readdirSync`, the same join `em query` uses),
// and every doc is visited once, in slice order, keyed by path — deterministic output.

import { collectModelInvariants, ModelInvariant, NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { loadSliceDocsOnce, joinSliceDocFast } from "../model/sliceDocIndex.js";
import { extractDeclaredInvariantLabels, extractInvariantIds, INV_TOKEN_RE } from "../cli/coverage.js";

interface DocEntry {
  path: string;
  /** The slice the doc is reported against: its canonical slice when one resolves it, else the
   *  first slice (in model order) whose join reaches it. */
  sliceKey: string;
  body: string;
}

export function validateInvariants(model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const modelInvariants = collectModelInvariants(model);
  const modelById = new Map<string, ModelInvariant>();
  for (const inv of modelInvariants) if (!modelById.has(inv.id)) modelById.set(inv.id, inv);

  const docsByKey = loadSliceDocsOnce(baseDir);
  const docs = new Map<string, DocEntry>();
  const docBySliceIndex = new Map<number, DocEntry>();
  model.slices.forEach((slice, i) => {
    const key = refs.sliceKeys[i];
    const doc = joinSliceDocFast(model, refs, slice, key, docsByKey);
    if (doc.body === null) return;
    let entry = docs.get(doc.path);
    if (!entry) {
      entry = { path: doc.path, sliceKey: key, body: doc.body };
      docs.set(doc.path, entry);
    } else if (doc.path === `slices/${key}.md`) {
      entry.sliceKey = key;
    }
    docBySliceIndex.set(i, entry);
  });

  const docDeclared = new Set<string>();
  const declaredIdsByPath = new Map<string, string[]>();
  for (const entry of docs.values()) {
    const ids = extractInvariantIds(entry.body);
    declaredIdsByPath.set(entry.path, ids);
    for (const id of ids) docDeclared.add(id);
  }

  // A `public` command is a contract input: its rules belong with it. Silent when the model or
  // the slice's own doc declares any invariant (the doc fallback keeps 1.13-style docs clean).
  for (const el of model.elements) {
    if (el.kind !== "command" || el.public !== true) continue;
    if ((el.invariants ?? []).length > 0) continue;
    const doc = docBySliceIndex.get(el.sliceIndex);
    if (doc && (declaredIdsByPath.get(doc.path) ?? []).length > 0) continue;
    pushDiag(diags, "invariants/public-command-without-invariants", {
      message:
        `public command "${el.name}" declares no invariants in the model or in its slice doc — ` +
        `add an \`invariant INV-<MNEMONIC>-<n> "rule"\` line after it`,
      line: el.line,
      refs: [refs.refById.get(el.id)!],
    });
  }

  for (const entry of docs.values()) {
    const cited: string[] = [];
    for (const m of entry.body.matchAll(INV_TOKEN_RE)) if (!cited.includes(m[0])) cited.push(m[0]);
    for (const id of cited) {
      if (modelById.has(id) || docDeclared.has(id)) continue;
      pushDiag(diags, "invariants/doc-cites-undeclared", {
        message:
          `${entry.path} (slice "${entry.sliceKey}") cites ${id}, which neither the model nor any ` +
          `slice doc's Invariants section declares`,
      });
    }
  }

  for (const entry of docs.values()) {
    for (const id of extractDeclaredInvariantLabels(entry.body)) {
      const inv = modelById.get(id);
      if (!inv) continue;
      pushDiag(diags, "invariants/declared-in-both", {
        message:
          `invariant "${id}" is declared in the model (${inv.element.kind} "${inv.element.name}") and ` +
          `restated as a rule in ${entry.path} — keep the model line; in the doc, cite the ID and elaborate`,
        line: inv.line,
      });
    }
  }

  return diags;
}
