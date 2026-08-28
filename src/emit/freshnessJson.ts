// SPDX-License-Identifier: MIT
// Builds the `em freshness --json` document (MIL-164): a versioned envelope around exactly one
// `ConformanceEntry` (see ../cli/status.ts) — the standalone surface for "last conformed at
// <rev> — N commits and M slice-PRs behind HEAD" without pulling in the rest of `em status`'s
// rollup. Same envelope shape/conventions as statusJson.ts/coverageJson.ts/ledgerJson.ts: a
// schema field versioned independently of both the npm package and every other command's own
// schema. This is also the EXACT document the MCP `freshness` tool returns (src/mcp/server.ts)
// — both callers build it by handing the same `ConformanceEntry` to this one function, so there
// is exactly one schema for this surface (MCP parity, same convention `status` established).

import { ConformanceEntry } from "../cli/status.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-164): initial shape.
export const FRESHNESS_SCHEMA_VERSION = "1.0";

/** Build the `em freshness <file> --json` document. Pretty-printed (2-space), no trailing
 *  newline — the caller adds it, same convention as buildStatusJson/buildCoverageJson. No
 *  timestamps or other non-deterministic fields: byte-identical for the same model/git state. */
export function buildFreshnessJson(entry: ConformanceEntry): string {
  const doc = {
    freshnessSchemaVersion: FRESHNESS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    ...entry,
  };
  return JSON.stringify(doc, null, 2);
}
