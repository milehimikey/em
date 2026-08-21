// SPDX-License-Identifier: MIT
// Builds the `em coverage --json` document: a versioned envelope around `CoverageReport` (see
// ../cli/coverage.ts). Follows `em ledger`/`em validate`'s conventions (ledgerJson.ts,
// validateJson.ts): a schema field versioned independently of both the npm package and every
// other command's own schema, explicit fields rather than a bare passthrough of the report shape.

import { CoverageReport } from "../cli/coverage.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-130): initial shape.
export const COVERAGE_SCHEMA_VERSION = "1.0";

/** Build the `em coverage <model>.em --tests <dir> --json` document. Pretty-printed (2-space),
 *  no trailing newline — the caller adds it, same convention as buildLedgerJson/buildDiffJson.
 *  `ok` is advisory-mode's own pass/fail (zero uncovered IDs) — it does NOT reflect `--strict`,
 *  which is a CLI exit-code decision layered on top of this same document, not a different
 *  document shape. */
export function buildCoverageJson(file: string, testsDir: string, report: CoverageReport): string {
  const doc = {
    coverageSchemaVersion: COVERAGE_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    testsDir,
    ok: report.uncoveredCount === 0,
    summary: {
      totalInvariants: report.totalInvariants,
      cited: report.totalInvariants - report.uncoveredCount,
      uncovered: report.uncoveredCount,
    },
    slices: report.slices,
  };
  return JSON.stringify(doc, null, 2);
}
