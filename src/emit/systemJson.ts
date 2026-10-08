// SPDX-License-Identifier: MIT
// Builds the `em system [<manifest>|<dir>] --json` document (MIL-194): a versioned envelope around
// `SystemReport` (src/system/verify.ts) — the verified seam list, each model's public surface,
// and the org-level context map (models as nodes, seams as edges) em-portal 0.4.0 renders.
// Same "one versioned envelope over what the builder already computed" convention as
// `emit/statusJson.ts`/`emit/queryJson.ts`, and the EXACT document the MCP `system` tool
// returns for the same manifest (src/mcp/server.ts) — both callers hand this one function the
// same `SystemReport`, so there is exactly one schema for this surface (MCP parity, docs/mcp.md).

import { createHash } from "node:crypto";
import { serializeDiagnostic } from "../model/validate.js";
import { SystemDiscovery, SystemReport } from "../system/verify.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-194): initial shape — manifest, models, seams, contextMap, diagnostics.
// 2.0 (MIL-235): seams are declared consumer-side (`consumes` on a translation), so `seams[]`
// lists every resolved `consumes` binding (then any legacy 1.0 manifest seam) in the same
// {from, to, fromSlice, toSlice, description, status, diagnostics} shape — `description` is
// null for a `consumes` binding. `models[].owner` and `contextMap.nodes[].owner` are now
// `string[]` (the model header's `owner` entries) instead of `string | null`. `manifest` is
// `null` when the system was discovered (no system.yaml), and the new `discovery: {root,
// files} | null` (before `diagnostics`) says what was found. Major bump: `owner`'s type changed.
//   - MIL-239 (additive, stays 2.0): `consumer-not-adapted` errors join `diagnostics` (same
//     array), and a new `consumerAdaptation: {checked, notAdapted}` summary sits after
//     `discovery`, before `diagnostics`. Seams carrying the finding have `status: "error"`.
export const SYSTEM_SCHEMA_VERSION = "2.0";

/** Where the system came from — exactly one of the two is non-null. */
export interface SystemJsonSource {
  manifestPath: string | null;
  manifestText: string | null;
  discovery: SystemDiscovery | null;
}

/** Build the `em system --json` document. Pretty-printed (2-space), no trailing newline — the
 *  caller adds it, same convention as every other `em` JSON surface. No timestamps or other
 *  non-deterministic fields: byte-identical for the same manifest (or discovered files) +
 *  models (the project-wide "deterministic core" constraint). `manifestPath` and
 *  `discovery.root` are echoed as given/reached from the command line (not resolved), same as
 *  `em export`'s `source.path`. */
export function buildSystemJson(source: SystemJsonSource, report: SystemReport): string {
  const doc = {
    systemSchemaVersion: SYSTEM_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    manifest:
      source.manifestPath === null
        ? null
        : {
            path: source.manifestPath,
            sha256: createHash("sha256").update(source.manifestText ?? "", "utf8").digest("hex"),
            name: report.name,
          },
    models: report.models,
    seams: report.seams,
    contextMap: report.contextMap,
    discovery: source.discovery,
    consumerAdaptation: report.consumerAdaptation,
    // Same serialized diagnostic shape em export/em diff use (severity, code, message, line,
    // refs), plus `file` since this is a multi-model surface (`em status --json`'s convention):
    // manifest-level findings point at the manifest, per-element ones at the model's source.
    diagnostics: report.diagnostics.map((d) => ({ file: d.file, ...serializeDiagnostic(d) })),
  };
  return JSON.stringify(doc, null, 2);
}
