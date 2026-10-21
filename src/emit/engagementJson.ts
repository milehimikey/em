// SPDX-License-Identifier: MIT
// `em engagement` (MIL-268) schema constants and the two JSON documents: `em engagement plan
// --json` and `em engagement status --json`. Both are also EXACTLY what the MCP
// `engagement_plan`/`engagement_status` tools return — one builder per surface, so the CLI and
// MCP can never drift (MCP parity). Pretty-printed (2-space), no trailing newline (the CLI adds
// it), no timestamps: byte-identical for the same model, docs and engagement file.

import type { EngagementPlan, EngagementStatus } from "../cli/engagement.js";
import type { FoundationCheck } from "../cli/engagementFoundation.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

/** The engagement FILE's frontmatter contract (`engagementSchemaVersion`, docs/engagement-schema.md).
 *  1.0 (MIL-268): slug, created, createdBy, parallel, status, slices[{key, state, branch, base, pr, heldBy?}].
 *  1.1 (GH #241): optional `tracking` — the engagement-level ticket key or URL. A 1.0 file still reads.
 *  1.2 (GH #334): optional `prTitle` — the PR title template (`{key}`, `{slice}`). 1.0 and 1.1 files still read. */
export const ENGAGEMENT_SCHEMA_VERSION = "1.2";

/** Every `engagementSchemaVersion` this em reads; it always writes {@link ENGAGEMENT_SCHEMA_VERSION}. */
export const ENGAGEMENT_READABLE_VERSIONS: readonly string[] = ["1.0", "1.1", "1.2"];

// 1.0 (MIL-268): initial shape.
// 1.1 (GH #241): additive `tracking` on the document and on each slice.
// 1.2 (GH #239): additive `preflight: [{ kind, subject, slices, message }]` — the model-wide gaps
//   the engagement's slices share (repeated-invariant, event-without-tag, shared-trigger,
//   doc-model-mismatch); advisory, never a hold. `[]` when there are none.
// 1.3 (GH #282): additive `preflight[].kind: "shape"` — one entry per shape-family lint
//   (`em validate --shape`) that fires on the engagement's slices; `subject` is the rule code.
// 1.4 (GH #334): additive `prTitle` on the document (the engagement's template, or `null`) and on
//   each slice (the resolved PR title the implementer is handed), and a `preflight[].kind:
//   "pr-title-fallback"` per keyless slice whose `{key}` template fell back to the default.
export const ENGAGEMENT_PLAN_SCHEMA_VERSION = "1.4";

// 1.0 (MIL-268): initial shape.
// 1.1 (GH #241): additive `tracking` on the document and on each slice.
export const ENGAGEMENT_STATUS_SCHEMA_VERSION = "1.1";

export function buildEngagementPlanJson(plan: EngagementPlan): string {
  const doc = {
    engagementPlanSchemaVersion: ENGAGEMENT_PLAN_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file: plan.file,
    engagement: plan.engagement,
    slug: plan.slug,
    status: plan.status,
    parallel: plan.parallel,
    tracking: plan.tracking,
    prTitle: plan.prTitle,
    levels: plan.levels,
    slices: plan.slices,
    preflight: plan.preflight,
  };
  return JSON.stringify(doc, null, 2);
}

// 1.0 (GH #240): `{ engagementFoundationSchemaVersion, generator, file, slug, code, scannedFiles,
//   events[{ event, emittedBy, consumedBy, status, files, missingFields, missingTagFields,
//   untaggedInModel, identifiers }], counts { present, incomplete, missingEvent }, ok }` —
//   `status` one of `present | incomplete | missing-event`. The MCP `engagement_foundation` tool
//   returns the same document.
export const ENGAGEMENT_FOUNDATION_SCHEMA_VERSION = "1.0";

export function buildEngagementFoundationJson(file: string, slug: string, check: FoundationCheck): string {
  const doc = {
    engagementFoundationSchemaVersion: ENGAGEMENT_FOUNDATION_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    slug,
    code: check.code,
    scannedFiles: check.scannedFiles,
    events: check.events,
    counts: check.counts,
    ok: check.ok,
  };
  return JSON.stringify(doc, null, 2);
}

export function buildEngagementStatusJson(status: EngagementStatus): string {
  const doc = {
    engagementStatusSchemaVersion: ENGAGEMENT_STATUS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file: status.file,
    engagement: status.engagement,
    slug: status.slug,
    status: status.status,
    created: status.created,
    createdBy: status.createdBy,
    parallel: status.parallel,
    tracking: status.tracking,
    slices: status.slices,
    counts: status.counts,
    closable: status.closable,
  };
  return JSON.stringify(doc, null, 2);
}
