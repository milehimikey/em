// SPDX-License-Identifier: MIT
// `em validate`'s `model-version-stale` rule (MIL-218): warns when the `.em` content hash or
// the slice-version vector has moved since the last `em model version bump` — the same
// `modelVersionDrift` predicate `em status` and the `em slice ratify`/`reratify` advisory
// share, never re-derived a third way. Same fs-aware-sibling shape as
// catalog/frontmatterCoherenceValidate.ts/orphanedSliceDocValidate.ts: a module next to
// model/validate.ts, not folded into it, because it needs `baseDir`/fs access (the
// `model-versions/*.json` manifest) the rest of validate deliberately never touches.
//
// Silent when no manifest exists at all (`drift.current === null`) — a repo that never bumped a
// design version has nothing to be stale against; nagging a project that has never opted into
// this feature would be exactly the "surprise new warning on every model" failure mode the
// ruling's "silent when no manifest exists" clause exists to avoid. Warning, never error:
// nothing about a stale design version blocks anything else in the model.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { modelVersionDrift } from "../cli/modelVersion.js";

/**
 * `baseDir` is the `.em` file's directory (manifests live at `<baseDir>/model-versions/`, same
 * convention every other doc/note/manifest path in `em` uses); `source` is the `.em` file's own
 * text, for the modelHash comparison.
 */
export function validateModelVersionStale(model: NormalizedModel, refs: RefsResult, baseDir: string, source: string): Diagnostic[] {
  const drift = modelVersionDrift(baseDir, model, refs, source);
  if (drift.current === null || (!drift.hashChanged && drift.slicesChanged.length === 0)) return [];

  const parts: string[] = [];
  if (drift.hashChanged) parts.push("the model's own content changed");
  if (drift.slicesChanged.length > 0) {
    parts.push(`${drift.slicesChanged.length} slice(s) moved (${drift.slicesChanged.map((c) => c.key).join(", ")})`);
  }
  const diags: Diagnostic[] = [];
  pushDiag(diags, "model-version-stale", {
    message: `model version v${drift.current} is stale — ${parts.join(" and ")} since it was bumped; run \`em model version bump\` to record it`,
  });
  return diags;
}
