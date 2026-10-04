// SPDX-License-Identifier: MIT
// Builds the `em upgrade --json` document (dry-run report, MIL-219): a versioned envelope
// around `UpgradeReport` (see ../cli/upgrade.ts). Follows em ledger/em diff/em skill check's
// conventions (ledgerJson.ts, diffJson.ts, skillCheckJson.ts): a schema field versioned
// independently of both the npm package and every other command's own schema. `--apply` never
// prints this document — it's a dry-run/`--check` artifact only (MCP's `upgrade` tool is
// dry-run-only for the same reason, ruling F).

import { UpgradeReport } from "../cli/upgrade.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0: initial shape (MIL-219).
// 1.1: (MIL-257) no shape change, but `stateFileError` semantics changed: it is `null` for an
//      ABSENT state file (the `state-file` step scaffolds it and shows as an applicable step) and
//      is set only for a file that exists but doesn't parse, as a sentence naming the file.
export const UPGRADE_SCHEMA_VERSION = "1.1";

/** Build the `em upgrade <file> --json` document. Pretty-printed (2-space), no trailing newline
 *  — the caller adds it, same convention as buildLedgerJson/buildDiffJson/buildSkillCheckJson. */
export function buildUpgradeJson(file: string, report: UpgradeReport): string {
  const doc = {
    upgradeSchemaVersion: UPGRADE_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    file,
    from: report.from,
    to: report.to,
    stateFileError: report.stateFileError,
    steps: report.steps,
    human: report.human,
  };
  return JSON.stringify(doc, null, 2);
}
