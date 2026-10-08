// SPDX-License-Identifier: MIT
// Builds the `em system scope --json` document (MIL-240): a versioned envelope around
// `ScopeReport` (src/system/scope.ts) plus the change-set facts the CLI gathered. Same
// conventions as systemJson.ts: pretty-printed 2-space, no trailing newline (the caller adds
// it), no timestamps, no absolute paths - byte-identical for the same repository state and the
// exact document the MCP `system_scope` tool returns.

import { serializeDiagnostic } from "../model/validate.js";
import type { ScopeReport } from "../system/scope.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-240): initial shape.
export const SCOPE_SCHEMA_VERSION = "1.0";

export interface ScopeJsonFacts {
  /** The `--base` revision as given, or null when only `--staged` was asked for. */
  base: string | null;
  staged: boolean;
  /** Repo-relative changed paths after the exemption (what the rules saw), sorted. */
  changedPaths: string[];
  /** Repo-relative paths dropped because every commit touching them carries `Em-Upgrade:`. */
  exemptPaths: string[];
}

export function buildScopeJson(facts: ScopeJsonFacts, report: ScopeReport): string {
  const doc = {
    scopeSchemaVersion: SCOPE_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    base: facts.base,
    staged: facts.staged,
    changedPaths: facts.changedPaths,
    exemptPaths: facts.exemptPaths,
    models: report.touched,
    unmappedPaths: report.unmapped,
    crossings: report.crossings,
    diagnostics: report.diagnostics.map((d) => ({ file: d.file, ...serializeDiagnostic(d) })),
  };
  return JSON.stringify(doc, null, 2);
}
