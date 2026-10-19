// SPDX-License-Identifier: MIT
// GH #282: `em validate --shape` — the focused view of the advisory storyline-shape lints. A rule
// belongs to it by one field alone, `family: "shape"` on its RULES entry (model/rules.ts), so a new
// shape lint plugs in by registering that field; nothing here names a rule. Advisory by
// construction: this module only groups and partitions diagnostics the validator already computed,
// and the CLI exits 0 whatever it finds. `--waive-file` reuses `em refs`'s waiver file (one slice
// key per line, `#` comments, missing file = no waivers) so an estate can baseline accepted shapes.

import type { Diagnostic } from "../model/validate.js";
import { RULES, type RuleCode } from "../model/rules.js";
import { readWaiveFile } from "./refsCheck.js";

export { readWaiveFile };

/** Every registered rule code in the shape family, registry order. */
export function shapeRuleCodes(): RuleCode[] {
  return (Object.keys(RULES) as RuleCode[]).filter((c) => (RULES[c] as { family?: string }).family === "shape");
}

export interface ShapeRuleReport {
  code: string;
  title: string;
  /** docs/validation.md anchor for the rule (`shape` unless the registry names another). */
  docAnchor: string;
  /** Findings that count (not waived). */
  findings: Diagnostic[];
  /** Findings a waive file excused — listed, never counted. */
  waived: Diagnostic[];
}

export interface ShapeReport {
  rules: ShapeRuleReport[];
  /** Total findings that count / that were waived. */
  findings: number;
  waived: number;
  /** Waiver keys that excused nothing, for a stderr note. */
  unknownWaivers: string[];
}

/** A finding is waived when it has refs and every one lies under a waived slice key (the bare key
 *  or `<key>/…`). A finding with no refs can never be waived: nothing identifies what is accepted. */
function isWaived(d: Diagnostic, keys: Set<string>): boolean {
  const refs = d.refs ?? [];
  if (refs.length === 0) return false;
  return refs.every((r) => [...keys].some((k) => r === k || r.startsWith(`${k}/`)));
}

export function buildShapeReport(diagnostics: Diagnostic[], waiveKeys: string[]): ShapeReport {
  const keys = new Set(waiveKeys);
  const used = new Set<string>();
  const rules: ShapeRuleReport[] = shapeRuleCodes().map((code) => {
    const def = RULES[code];
    const findings: Diagnostic[] = [];
    const waived: Diagnostic[] = [];
    for (const d of diagnostics.filter((x) => x.code === code)) {
      if (isWaived(d, keys)) {
        waived.push(d);
        for (const r of d.refs ?? []) for (const k of keys) if (r === k || r.startsWith(`${k}/`)) used.add(k);
      } else findings.push(d);
    }
    return { code, title: def.title, docAnchor: (def as { docAnchor?: string }).docAnchor ?? "shape", findings, waived };
  });
  return {
    rules,
    findings: rules.reduce((n, r) => n + r.findings.length, 0),
    waived: rules.reduce((n, r) => n + r.waived.length, 0),
    unknownWaivers: [...keys].filter((k) => !used.has(k)),
  };
}

/** Text table: rule, count, first ref, docs anchor; waived findings listed separately below. */
export function formatShapeText(report: ShapeReport, modelErrors: number): string {
  const rows = report.rules.map((r) => [r.code, String(r.findings.length), r.findings[0]?.refs?.[0] ?? "-", `docs/validation.md#${r.docAnchor}`]);
  const head = ["rule", "count", "first ref", "docs"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const out = [line(head), ...rows.map(line)];
  if (report.waived > 0) {
    out.push("", `waived (${report.waived}, not counted):`);
    for (const r of report.rules) for (const d of r.waived) out.push(`  ${r.code}: ${(d.refs ?? []).join(", ")}`);
  }
  out.push("", report.findings === 0 ? "ok — no shape findings" : `${report.findings} shape finding(s) — fix each, or record it as \`shape-accepted: <rule> <refs> — <reason>\` in the model README's Decisions log (advisory: exit 0)`);
  if (modelErrors > 0) out.push(`note: the model has ${modelErrors} error(s) — run \`em validate\`; shape findings may be incomplete`);
  return out.join("\n");
}
