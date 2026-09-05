// SPDX-License-Identifier: MIT
// Builds the `em query <verb> --json` document (MIL-168): one schema for all eight verbs, a
// `verb` discriminator field, and a `results` array whose entries are verb-shaped (see
// query/verbs.ts's per-verb result interfaces) — same "one versioned envelope over whatever the
// builder already computed" convention as `emit/statusJson.ts`/`emit/coverageJson.ts`. This is
// the EXACT document the MCP `query` tool returns for the same inputs (src/mcp/server.ts) — both
// callers build it by handing this function the same verb function's result, so there is exactly
// one schema for this surface (MCP parity, docs/mcp.md).

import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-168): initial shape — verb, files, args, results.
export const QUERY_SCHEMA_VERSION = "1.0";

/** Build the `em query <verb> ... --json` document. Pretty-printed (2-space), no trailing
 *  newline — the caller adds it, same convention as every other `em` JSON surface. No
 *  timestamps or other non-deterministic fields: byte-identical for the same models/args
 *  (the project-wide "deterministic core" constraint). */
export function buildQueryJson(verb: string, files: string[], args: Record<string, unknown>, results: unknown[]): string {
  const doc = {
    querySchemaVersion: QUERY_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    verb,
    files,
    // An omitted optional parameter echoes as an explicit `null` on a stable key (docs/cli.md's
    // documented `args` contract) — JSON.stringify would otherwise drop an `undefined` key.
    args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === undefined ? null : v])),
    results,
  };
  return JSON.stringify(doc, null, 2);
}
