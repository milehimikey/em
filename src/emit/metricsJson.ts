// SPDX-License-Identifier: MIT
// Builds the `em metrics --from <rev> --json` document (MIL-170): a versioned envelope around
// `MetricsResult` (see ../cli/metrics.ts). Same conventions as statusJson.ts/freshnessJson.ts/
// ledgerJson.ts: a schema field versioned independently of both the npm package and every other
// command's own schema — also the exact document the MCP `metrics` tool returns (src/mcp/
// server.ts), so there is exactly one schema for this surface (MCP parity).

import { MetricsResult } from "../cli/metrics.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-170): initial shape.
export const METRICS_SCHEMA_VERSION = "1.0";

/** Build the `em metrics <file> --from <rev> [--to <rev>] --json` document. Pretty-printed
 *  (2-space), no trailing newline — the caller adds it, same convention as buildStatusJson/
 *  buildFreshnessJson. No timestamps or other non-deterministic fields: byte-identical for the
 *  same repository state and range. */
export function buildMetricsJson(result: MetricsResult): string {
  const doc = {
    metricsSchemaVersion: METRICS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    from: result.from,
    to: result.to,
    ratificationTurnaround: result.ratificationTurnaround,
    conformCadence: result.conformCadence,
    statusVsReality: result.statusVsReality,
    readinessGateEffect: result.readinessGateEffect,
  };
  return JSON.stringify(doc, null, 2);
}
