// SPDX-License-Identifier: MIT
// Builds the `em system codeowners --json` document (MIL-234) — shared by the CLI and the MCP
// `system_codeowners` tool so the two are byte-identical. Own schema constant, independent of
// the export and system schemas; deterministic for the same inputs (no timestamps, no absolute
// paths — `file` is as given or reached from the command line).

import type { CodeownersEntry, CodeownersStatus } from "../system/codeowners.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-234): initial shape.
export const CODEOWNERS_SCHEMA_VERSION = "1.0";

export function buildCodeownersJson(file: string, entries: CodeownersEntry[], status: CodeownersStatus): string {
  const doc = {
    codeownersSchemaVersion: CODEOWNERS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    entries: entries.map((e) => ({ path: e.path, owners: e.owners, reason: e.reason })),
    status,
  };
  return JSON.stringify(doc, null, 2);
}
