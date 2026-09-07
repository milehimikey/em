// SPDX-License-Identifier: MIT
// Builds the `em status --json` document: a versioned envelope around `StatusReport` (see
// ../cli/status.ts). Follows `em coverage`/`em ledger`'s conventions (coverageJson.ts,
// ledgerJson.ts): a schema field versioned independently of both the npm package and every
// other command's own schema. This is also the EXACT document the MCP `status` tool returns
// (src/mcp/server.ts) — both callers build it by handing the same `StatusReport` to this one
// function, so there is exactly one schema for this surface (MCP parity, MIL-163).

import { StatusReport } from "../cli/status.js";
import { serializeDiagnostic } from "../model/validate.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./json.js";

// 1.0 (MIL-163): initial shape.
// 1.1 (MIL-164): each `conformance[]` entry gains `slicePRsBehindHead` (number | null) —
// candidate-slice count from the same conform-scope machinery, alongside `commitsBehindHead`.
// 1.2 (MIL-171): a new top-level `owners` array — one `{ file, key, owner }` entry per slice
// across every input file, `owner` verbatim from the doc's frontmatter `owner:` (null when
// absent or when no doc was found). See ../cli/status.ts's StatusOwnerEntry.
// 1.3 (MIL-202): each `conformance[]` entry gains `constitution: { present, path }` — whether
// the project's implementation constitution exists, and its expected location relative to that
// entry's own `modelDir` (`/`-separated, never absolute). Existence only; the document's content
// is never read. See ../cli/status.ts's ConstitutionEntry/resolveConstitution.
// 1.4 (MIL-208): a new top-level `continuations` (number) — count of continuation slices
// (again-view-only slices with no legacy doc of their own) across every input file, excluded
// from every `slices.byStatus`/`driftSignal` bucket (the originating slice's own fact already
// counts once). See ../cli/status.ts's StatusReport.continuations.
export const STATUS_SCHEMA_VERSION = "1.4";

/** Build the `em status <files...> --json` document. Pretty-printed (2-space), no trailing
 *  newline — the caller adds it, same convention as buildCoverageJson/buildLedgerJson. No
 *  timestamps or other non-deterministic fields: byte-identical for the same models/git state
 *  (MIL-163's "deterministic core" constraint). */
export function buildStatusJson(report: StatusReport): string {
  const doc = {
    statusSchemaVersion: STATUS_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    files: report.files,
    slices: report.slices,
    continuations: report.continuations,
    driftSignal: report.driftSignal,
    invariants: report.invariants,
    issues: report.issues,
    conformance: report.conformance,
    owners: report.owners,
    // Doc-join diagnostics (binding-missing-file/frontmatter-invalid), tagged with the file
    // each concerns — same serialized diagnostic shape em export/em diff use (severity, code,
    // message, line, refs), plus `file` since this is a multi-model surface.
    diagnostics: report.diagnostics.map((d) => ({ file: d.file, ...serializeDiagnostic(d) })),
  };
  return JSON.stringify(doc, null, 2);
}
