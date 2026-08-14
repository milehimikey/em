// SPDX-License-Identifier: MIT
// `em validate`'s lineage-ref resolution (MIL-84): checks what the *current tree* can prove
// wrong about a slice doc's `split-from`/`merged-from`/`superseded-by` frontmatter, and stays
// silent about what it can't. Ratified ruling (Linear MIL-84, 2026-08-13):
//
//   Backward lineage refs (`split-from`, `merged-from`) are claims about history; for
//   rename/merge/remove the predecessor is *supposed* to be absent from the current tree —
//   `merged-from: cart@v3` on a doc whose predecessor was legitimately removed references an
//   absent key forever, that's steady state, not a defect. So a backward ref naming a key
//   absent from the current model gets NO diagnostic, not even a warning.
//
//   What *is* checked (all errors, all current-tree-checkable): malformed ref grammar;
//   self-reference/cycles; a dangling forward ref (`superseded-by` naming an absent key —
//   forward refs point at the *present*, so absence is a real broken reference); impossible
//   version arithmetic when the referenced key resolves in-tree (a ref to a version number
//   higher than the target doc's own current `version:` — a reference to a future that hasn't
//   happened).
//
// Deep historical verification (did slice@vN actually, once, exist?) is deliberately out of
// scope here — a same-commit authoring convention substitutes for it (see
// docs/slice-doc-schema.md's lineage section): the lineage ref is written in the same
// ratification commit that performs the operation it records, so the PR diff already contains
// both sides of the claim. `em ledger` (MIL-89, src/cli/ledgerCheck.ts) is that CI-recipe-tier,
// two-revision shape for a related but different invariant — version:/content agreement, not
// lineage-ref resolution — kept opt-in and separate for the same reason: it needs git history,
// and this command stays a fast function of the current tree.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { SliceDoc, SliceRef } from "./sliceDoc.js";

/** One declared lineage ref, with enough context to point a diagnostic at it. */
interface LineageEdge {
  ownerKey: string;
  ownerLine: number;
  field: "split-from" | "merged-from" | "superseded-by";
  ref: SliceRef;
}

function edgesOf(ownerKey: string, ownerLine: number, doc: SliceDoc): LineageEdge[] {
  const edges: LineageEdge[] = [];
  if (doc.splitFrom) edges.push({ ownerKey, ownerLine, field: "split-from", ref: doc.splitFrom });
  for (const ref of doc.mergedFrom) edges.push({ ownerKey, ownerLine, field: "merged-from", ref });
  for (const ref of doc.supersededBy) edges.push({ ownerKey, ownerLine, field: "superseded-by", ref });
  return edges;
}

/**
 * Resolve every slice's lineage refs against the current tree and report what the current tree
 * can prove wrong. `baseDir` is the `.em` file's directory (doc paths, like every other
 * doc/note path in em, are relative to it).
 */
export function validateLineage(model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const inModel = new Set(refs.sliceKeys);

  // Cache doc reads: a slice can be visited both as an edge owner and as another edge's
  // resolved target, and there's no reason to read the same file twice.
  const docCache = new Map<string, SliceDoc | null>();
  const docFor = (sliceKey: string): SliceDoc | null => {
    if (!docCache.has(sliceKey)) docCache.set(sliceKey, readSliceDoc(baseDir, sliceKey));
    return docCache.get(sliceKey)!;
  };

  const edges: LineageEdge[] = [];
  model.slices.forEach((slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    const doc = docFor(sliceKey);
    if (doc) edges.push(...edgesOf(sliceKey, slice.line, doc));
  });

  // Malformed grammar, self-reference, and dangling-forward are each a single edge-local check.
  // Version arithmetic and cycles need every edge whose target resolves in-model, gathered
  // first, so they're handled in a second pass below.
  const resolvableEdges: LineageEdge[] = [];
  for (const edge of edges) {
    if (edge.ref.sliceKey === null) {
      pushDiag(diags, "lineage-ref-malformed", {
        message: `slice "${edge.ownerKey}"'s ${edge.field} value "${edge.ref.raw}" doesn't match the <slice-key>@v<N> grammar`,
        line: edge.ownerLine,
        refs: [edge.ownerKey],
      });
      continue;
    }
    if (edge.ref.sliceKey === edge.ownerKey) {
      pushDiag(diags, "lineage-ref-cycle", {
        message: `slice "${edge.ownerKey}"'s ${edge.field} names itself (${edge.ref.raw})`,
        line: edge.ownerLine,
        refs: [edge.ownerKey],
      });
      continue;
    }
    if (edge.field === "superseded-by" && !inModel.has(edge.ref.sliceKey)) {
      pushDiag(diags, "lineage-forward-dangling", {
        message: `slice "${edge.ownerKey}"'s superseded-by names "${edge.ref.sliceKey}", which isn't a slice in the current model`,
        line: edge.ownerLine,
        refs: [edge.ownerKey],
      });
      continue;
    }
    if (inModel.has(edge.ref.sliceKey)) resolvableEdges.push(edge);
    // else: a backward ref (split-from/merged-from) naming a key absent from the current
    // model — the expected steady state for a real split/merge/remove. No diagnostic.
  }

  // Version arithmetic: only checkable when the target resolves in-model AND its own doc has a
  // readable numeric version. Silently skip otherwise — can't check what isn't there.
  for (const edge of resolvableEdges) {
    const targetDoc = docFor(edge.ref.sliceKey!);
    if (!targetDoc || targetDoc.version === null) continue;
    if (edge.ref.version! > targetDoc.version) {
      pushDiag(diags, "lineage-version-impossible", {
        message: `slice "${edge.ownerKey}"'s ${edge.field} names "${edge.ref.sliceKey}"@v${edge.ref.version}, but "${edge.ref.sliceKey}" is only at v${targetDoc.version}`,
        line: edge.ownerLine,
        refs: [edge.ownerKey, edge.ref.sliceKey!],
      });
    }
  }

  // Multi-node cycles: adjacency over edges whose target resolves in-model (self-loops already
  // reported above, and excluded here so they aren't double-counted as a 1-node "cycle"). 3-color
  // DFS, same shape as model/validate.ts's findTypeCycles(), adapted to string slice keys.
  const adjacency = new Map<string, string[]>();
  for (const edge of resolvableEdges) {
    if (edge.ref.sliceKey === edge.ownerKey) continue;
    const list = adjacency.get(edge.ownerKey);
    if (list) list.push(edge.ref.sliceKey!);
    else adjacency.set(edge.ownerKey, [edge.ref.sliceKey!]);
  }
  const color = new Map<string, 0 | 1 | 2>(); // 0 = white, 1 = gray (on stack), 2 = black (done)
  const stack: string[] = [];
  const reportedCycles = new Set<string>();
  const lineOf = new Map<string, number>();
  model.slices.forEach((slice, i) => lineOf.set(refs.sliceKeys[i], slice.line));

  function visit(key: string): void {
    color.set(key, 1);
    stack.push(key);
    for (const dep of adjacency.get(key) ?? []) {
      const c = color.get(dep) ?? 0;
      if (c === 0) {
        visit(dep);
      } else if (c === 1) {
        const idx = stack.indexOf(dep);
        const cyclePath = [...stack.slice(idx), dep];
        const dedupeKey = [...new Set(cyclePath)].sort().join(",");
        if (!reportedCycles.has(dedupeKey)) {
          reportedCycles.add(dedupeKey);
          const cycleRefs = [...new Set(cyclePath)];
          pushDiag(diags, "lineage-ref-cycle", {
            message: `slice "${dep}" is part of a lineage cycle: ${cyclePath.join(" -> ")}`,
            line: lineOf.get(dep),
            refs: cycleRefs,
          });
        }
      }
      // c === 2 (black): already fully explored via another path — not a new cycle.
    }
    stack.pop();
    color.set(key, 2);
  }
  for (const key of adjacency.keys()) {
    if ((color.get(key) ?? 0) === 0) visit(key);
  }

  return diags;
}
