// SPDX-License-Identifier: MIT
// Builds the `em system <manifest> --json` document (MIL-194): a versioned envelope around
// `SystemReport` (src/system/verify.ts) — the verified seam list, each model's public surface,
// and the org-level context map (models as nodes, seams as edges) em-portal 0.4.0 renders.
// Same "one versioned envelope over what the builder already computed" convention as
// `emit/statusJson.ts`/`emit/queryJson.ts`, and the EXACT document the MCP `system` tool
// returns for the same manifest (src/mcp/server.ts) — both callers hand this one function the
// same `SystemReport`, so there is exactly one schema for this surface (MCP parity, docs/mcp.md).

import { createHash } from "node:crypto";
import { serializeDiagnostic } from "../model/validate.js";
import { SystemReport } from "../system/verify.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-194): initial shape — manifest, models, seams, contextMap, diagnostics.
export const SYSTEM_SCHEMA_VERSION = "1.0";

/** Build the `em system <manifest> --json` document. Pretty-printed (2-space), no trailing
 *  newline — the caller adds it, same convention as every other `em` JSON surface. No
 *  timestamps or other non-deterministic fields: byte-identical for the same manifest + models
 *  (the project-wide "deterministic core" constraint). `manifestPath` is echoed as given on the
 *  command line (not resolved), same as `em export`'s `source.path`. */
export function buildSystemJson(manifestPath: string, manifestText: string, report: SystemReport): string {
  const doc = {
    systemSchemaVersion: SYSTEM_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    manifest: {
      path: manifestPath,
      sha256: createHash("sha256").update(manifestText, "utf8").digest("hex"),
      name: report.name,
    },
    models: report.models,
    seams: report.seams,
    contextMap: report.contextMap,
    // Same serialized diagnostic shape em export/em diff use (severity, code, message, line,
    // refs), plus `file` since this is a multi-model surface (`em status --json`'s convention):
    // manifest-level findings point at the manifest, per-element ones at the model's source.
    diagnostics: report.diagnostics.map((d) => ({ file: d.file, ...serializeDiagnostic(d) })),
  };
  return JSON.stringify(doc, null, 2);
}
