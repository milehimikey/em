// SPDX-License-Identifier: MIT
// Builds the `em usage-report --json` document: a versioned envelope around `UsageReport` (see
// ../cli/usageLog.ts). Follows every other command's convention (statusJson.ts/coverageJson.ts):
// a schema field versioned independently of both the npm package and every other command's own
// schema. Pretty-printed, no trailing newline, no timestamps — byte-identical for the same
// input files.

import { UsageReport } from "../cli/usageLog.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-161): initial shape.
export const USAGE_REPORT_SCHEMA_VERSION = "1.0";

export function buildUsageReportJson(report: UsageReport): string {
  const doc = {
    usageReportSchemaVersion: USAGE_REPORT_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    root: report.root,
    files: report.files,
    sessions: report.sessions,
    phaseCounts: report.phaseCounts,
    categoryCounts: report.categoryCounts,
    unparseableLines: report.unparseableLines,
  };
  return JSON.stringify(doc, null, 2);
}
