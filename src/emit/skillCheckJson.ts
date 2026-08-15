// SPDX-License-Identifier: MIT
// Builds the `em skill check --json` document: a versioned envelope around SkillCheckResult
// (see ../cli/skillCheck.ts). Follows em ledger/em diff/em glossary's conventions
// (ledgerJson.ts, diffJson.ts, glossaryJson.ts): a schema field versioned independently of
// both the npm package and every other command's own schema.

import { SkillCheckFinding, SkillCheckResult } from "../cli/skillCheck.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0: initial shape (MIL-93).
export const SKILL_CHECK_SCHEMA_VERSION = "1.0";

/**
 * `SkillCheckFinding` with every optional field widened to an explicit `null`. Mapped off
 * `SkillCheckFinding` rather than hand-listed so adding a field there is a compile error here,
 * not a field that silently stops being serialized — same pattern as diffJson.ts's
 * `SerializedEntry`/`serializeEntry`.
 */
type SerializedFinding = { code: SkillCheckFinding["code"]; message: string } & {
  [K in Exclude<keyof SkillCheckFinding, "code" | "message">]-?: NonNullable<SkillCheckFinding[K]> | null;
};

/** `SkillCheckFinding` with every optional field present, explicit `null` when unused by `code`. */
function serializeFinding(f: SkillCheckFinding): SerializedFinding {
  return {
    code: f.code,
    message: f.message,
    vendoredStamp: f.vendoredStamp ?? null,
    installedVersion: f.installedVersion ?? null,
    driftedFiles: f.driftedFiles ?? null,
  };
}

/** Build the `em skill check --json` document. Pretty-printed (2-space), no trailing newline —
 *  the caller adds it, same convention as buildLedgerJson/buildDiffJson/buildGlossaryJson. */
export function buildSkillCheckJson(result: SkillCheckResult, vendoredDir: string, installedVersion: string): string {
  const doc = {
    skillCheckSchemaVersion: SKILL_CHECK_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    vendoredDir,
    installedVersion,
    findings: result.findings.map(serializeFinding),
    ok: result.ok,
  };
  return JSON.stringify(doc, null, 2);
}
