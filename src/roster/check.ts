// SPDX-License-Identifier: MIT
// `em roster check <model>` (GH #259): the whole-model CI enforcement of the ratifier roster. Where
// `--slice-ready <key>` judges one ready-to-implement slice, this walks EVERY bound slice doc and
// tests each recorded signer against the roster: `ratifiedBy` on `ready-to-implement` and
// `implemented` docs, `reviewedBy` on any doc that carries one. em's own `grandfathered ...`
// placeholder is not a signer and is exempt (counted, so the exemption is visible).

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { Diagnostic } from "../model/validate.js";
import { makeDiag } from "../model/rules.js";
import { LoadedRoster, RosterRole, isGrandfatheredSignoff, rosterRefusal, sliceContexts } from "./roster.js";

export const ROSTER_CHECK_SCHEMA_VERSION = "1.0";

export interface RosterCheckResult {
  sliceKey: string;
  doc: string;
  role: RosterRole;
  name: string;
  status: string | null;
  contexts: string[];
  ok: boolean;
  /** The refusal text when `ok` is false. */
  message: string | null;
}

export interface RosterCheckReport {
  roster: { state: LoadedRoster["state"]; path: string | null };
  results: RosterCheckResult[];
  /** Docs whose signer is em's `grandfathered ...` migration marker -- exempt, counted. */
  grandfathered: number;
  diagnostics: Diagnostic[];
  /** No roster, or a valid one with every checked signer permitted. */
  ok: boolean;
}

const RATIFIED_STATUSES = new Set(["ready-to-implement", "implemented"]);

export function checkRoster(model: NormalizedModel, refs: RefsResult, baseDir: string, file: string, loaded: LoadedRoster): RosterCheckReport {
  if (loaded.state === "absent") return { roster: { state: "absent", path: null }, results: [], grandfathered: 0, diagnostics: [], ok: true };
  if (loaded.state === "invalid") {
    return {
      roster: { state: "invalid", path: loaded.path },
      results: [],
      grandfathered: 0,
      diagnostics: loaded.diagnostics.map((d) => makeDiag("roster-invalid", { message: `${loaded.path}: ${d.message}`, line: d.line })),
      ok: false,
    };
  }
  const modelKey = computeModelKey(model, file);
  const results: RosterCheckResult[] = [];
  const diagnostics: Diagnostic[] = [];
  const seenDocs = new Set<string>();
  let grandfathered = 0;
  refs.sliceKeys.forEach((sliceKey, i) => {
    const { doc, continuationOf } = resolveSliceDocJoin(model, refs, model.slices[i], sliceKey, baseDir, (id) => refs.refById.get(id)!);
    if (continuationOf || doc.reason !== null || seenDocs.has(doc.path)) return;
    seenDocs.add(doc.path);
    const contexts = sliceContexts(model, i);
    const signers: Array<[RosterRole, string | null]> = [
      ["ratifiers", doc.status !== null && RATIFIED_STATUSES.has(doc.status) ? doc.ratifiedBy : null],
      ["reviewers", doc.reviewedBy],
    ];
    let countedGrandfathered = false;
    for (const [role, name] of signers) {
      if (!name) continue;
      if (isGrandfatheredSignoff(name)) {
        if (!countedGrandfathered) grandfathered++;
        countedGrandfathered = true;
        continue;
      }
      const refusal = rosterRefusal(loaded.roster, role, name, contexts, modelKey);
      const ok = refusal === null;
      results.push({ sliceKey, doc: doc.path, role, name, status: doc.status, contexts, ok, message: refusal });
      if (!ok) {
        diagnostics.push(
          makeDiag(role === "ratifiers" ? "ratified-by-not-in-roster" : "reviewed-by-not-in-roster", {
            message: `slice "${sliceKey}" (${doc.path}): ${role === "ratifiers" ? "ratifiedBy" : "reviewedBy"} ${refusal} (${loaded.path})`,
            refs: [sliceKey],
          }),
        );
      }
    }
  });
  return { roster: { state: "present", path: loaded.path }, results, grandfathered, diagnostics, ok: diagnostics.length === 0 };
}

export function grandfatheredNotice(n: number): string | null {
  return n > 0 ? `${n} doc${n === 1 ? "" : "s"} ${n === 1 ? "carries" : "carry"} the grandfathered placeholder and ${n === 1 ? "is" : "are"} exempt until re-ratified` : null;
}

export function formatRosterCheck(report: RosterCheckReport): string[] {
  if (report.roster.state === "absent") return ["no ratifiers.yaml found - nothing to check"];
  const lines: string[] = [];
  if (report.roster.state === "invalid") return lines;
  const bad = report.results.filter((r) => !r.ok).length;
  lines.push(
    bad === 0
      ? `ok - ${report.results.length} recorded signer(s) all on ${report.roster.path}`
      : `${bad} of ${report.results.length} recorded signer(s) not permitted by ${report.roster.path}`,
  );
  const g = grandfatheredNotice(report.grandfathered);
  if (g) lines.push(g);
  return lines;
}

export function buildRosterCheckJson(file: string, report: RosterCheckReport): string {
  return JSON.stringify(
    {
      rosterCheckSchemaVersion: ROSTER_CHECK_SCHEMA_VERSION,
      file,
      roster: report.roster,
      ok: report.ok,
      grandfathered: report.grandfathered,
      results: report.results,
      diagnostics: report.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message, line: d.line ?? null, refs: d.refs ?? [] })),
    },
    null,
    2,
  );
}
