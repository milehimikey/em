// SPDX-License-Identifier: MIT
// Builds the `em status --json` document: a versioned envelope around `StatusReport` (see
// ../cli/status.ts). Follows `em coverage`/`em ledger`'s conventions (coverageJson.ts,
// ledgerJson.ts): a schema field versioned independently of both the npm package and every
// other command's own schema. This is also the EXACT document the MCP `status` tool returns
// (src/mcp/server.ts) — both callers build it by handing the same `StatusReport` to this one
// function, so there is exactly one schema for this surface (MCP parity, MIL-163).

import { StatusReport } from "../cli/status.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-163): initial shape.
export const STATUS_SCHEMA_VERSION = "1.0";

/** Build the `em status <files...> --json` document. Pretty-printed (2-space), no trailing
 *  newline — the caller adds it, same convention as buildCoverageJson/buildLedgerJson. No
 *  timestamps or other non-deterministic fields: byte-identical for the same models/git state
 *  (MIL-163's "deterministic core" constraint). */
export function buildStatusJson(report: StatusReport): string {
  const doc = {
    statusSchemaVersion: STATUS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    files: report.files,
    slices: report.slices,
    driftSignal: report.driftSignal,
    invariants: report.invariants,
    issues: report.issues,
    conformance: report.conformance,
  };
  return JSON.stringify(doc, null, 2);
}
