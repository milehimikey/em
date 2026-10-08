// SPDX-License-Identifier: MIT
// `em engagement` (MIL-268) schema constants and the two JSON documents: `em engagement plan
// --json` and `em engagement status --json`. Both are also EXACTLY what the MCP
// `engagement_plan`/`engagement_status` tools return — one builder per surface, so the CLI and
// MCP can never drift (MCP parity). Pretty-printed (2-space), no trailing newline (the CLI adds
// it), no timestamps: byte-identical for the same model, docs and engagement file.

import type { EngagementPlan, EngagementStatus } from "../cli/engagement.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

/** The engagement FILE's frontmatter contract (`engagementSchemaVersion`, docs/engagement-schema.md).
 *  1.0 (MIL-268): slug, created, createdBy, parallel, status, slices[{key, state, branch, base, pr, heldBy?}]. */
export const ENGAGEMENT_SCHEMA_VERSION = "1.0";

// 1.0 (MIL-268): initial shape.
export const ENGAGEMENT_PLAN_SCHEMA_VERSION = "1.0";

// 1.0 (MIL-268): initial shape.
export const ENGAGEMENT_STATUS_SCHEMA_VERSION = "1.0";

export function buildEngagementPlanJson(plan: EngagementPlan): string {
  const doc = {
    engagementPlanSchemaVersion: ENGAGEMENT_PLAN_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file: plan.file,
    engagement: plan.engagement,
    slug: plan.slug,
    status: plan.status,
    parallel: plan.parallel,
    levels: plan.levels,
    slices: plan.slices,
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
    slices: status.slices,
    counts: status.counts,
    closable: status.closable,
  };
  return JSON.stringify(doc, null, 2);
}
