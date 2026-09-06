// SPDX-License-Identifier: MIT
// Builds the `em ledger --json` document: a versioned envelope around `LedgerCheckResult`
// (see ../cli/ledgerCheck.ts). Follows `em diff`/`em glossary`'s conventions (emit/diffJson.ts,
// emit/glossaryJson.ts): a schema field versioned independently of both the npm package and
// every other command's own schema, explicit `null` for "no --to" (working tree) so a consumer
// can destructure without sniffing.

import { LedgerCheckResult } from "../cli/ledgerCheck.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0: initial shape (MIL-89).
// 1.1 (MIL-185): additive `waived` field — findings excused by `--waive <slice-key>` or an
// `Em-Ledger-Waive: <slice-key>` commit trailer, each carrying `waivedBy: { source: "flag" } |
// { source: "trailer", commit }`. A run with no waivers is byte-identical to the 1.0 shape
// except for the new empty `waived: []` array — every other field is unchanged.
export const LEDGER_SCHEMA_VERSION = "1.1";

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
    waived: result.waived,
    skipped: result.skipped,
    ok: result.findings.length === 0,
  };
  return JSON.stringify(doc, null, 2);
}
