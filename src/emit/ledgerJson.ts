// SPDX-License-Identifier: MIT
// Builds the `em ledger --json` document: a versioned envelope around `LedgerCheckResult`
// (see ../cli/ledgerCheck.ts). Follows `em diff`/`em glossary`'s conventions (emit/diffJson.ts,
// emit/glossaryJson.ts): a schema field versioned independently of both the npm package and
// every other command's own schema, explicit `null` for "no --to" (working tree) so a consumer
// can destructure without sniffing.

import { LedgerCheckResult } from "../cli/ledgerCheck.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0: initial shape (MIL-89).
export const LEDGER_SCHEMA_VERSION = "1.0";

/** Build the `em ledger --json` document. Pretty-printed (2-space), no trailing newline — the
 *  caller adds it, same convention as buildDiffJson/buildGlossaryJson. */
export function buildLedgerJson(result: LedgerCheckResult, from: string, to: string | null): string {
  const doc = {
    ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    from,
    to,
    checkedCount: result.checkedCount,
    findings: result.findings,
    skipped: result.skipped,
    ok: result.findings.length === 0,
  };
  return JSON.stringify(doc, null, 2);
}
