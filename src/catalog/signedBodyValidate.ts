// SPDX-License-Identifier: MIT
// GH #257: `em validate --check-signed-bodies` — the model-wide, status-independent twin of
// `--slice-ready`'s `slice-ready-body-changed-since-ratification`. That check runs for ONE slice
// and only while it is `ready-to-implement`; after `em slice mark-implemented` flips the doc to
// `implemented`, nothing compares the recorded `ratifiedHash` to the body again, so a shipped
// doc's signed content can drift with no diagnostic anywhere (`em ledger` watches `version:`
// against content, never the hash — and a repo that suspends ledger as a gate has nothing left).
// Opt-in: every doc that carries a `ratifiedHash:` is compared, whatever its status, through
// `ratifiedHashScope` (GH #253, GH #347) — a hash in an older scope whose body is intact (`legacy`,
// `v1.17`) is not a defect; neither is a generated region `em slice sync` rewrote (outside the hash),
// and a deferral `em slice defer` appended is outside the hash by construction.
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { hasUsableFrontmatter, ratifiedHashScope } from "./sliceDoc.js";

/** One `slice-body-changed-since-ratification` error per doc whose body no longer matches its
 *  recorded `ratifiedHash` (in either scope). `baseDir` is the `.em` file's directory. Docs with
 *  no hash are not reported — `--slice-ready --require-ratified-hash` (GH #256) is that check. */
export function validateSignedBodies(model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();
  model.slices.forEach((slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    const doc = readSliceDoc(baseDir, sliceKey);
    if (!doc || !hasUsableFrontmatter(doc) || doc.ratifiedHash === null) return;
    if (seen.has(sliceKey)) return;
    seen.add(sliceKey);
    if (ratifiedHashScope(doc.raw, doc.ratifiedHash) !== "mismatch") return;
    pushDiag(diags, "slice-body-changed-since-ratification", {
      message:
        `slice "${sliceKey}"'s doc slices/${sliceKey}.md (status: ${doc.status ?? "(none)"}, v${doc.version ?? "?"}) was edited after ratification — ` +
        "body no longer matches ratifiedHash; revert the edit, or open the next version (`em slice revise`) and re-ratify",
      line: slice.line,
      refs: [sliceKey],
    });
  });
  return diags;
}
