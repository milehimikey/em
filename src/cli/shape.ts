// SPDX-License-Identifier: MIT
// GH #282: `em validate --shape` — the focused view of the advisory storyline-shape lints. A rule
// belongs to it by one field alone, `family: "shape"` on its RULES entry (model/rules.ts), so a new
// shape lint plugs in by registering that field; nothing here names a rule. Advisory by
// construction: this module only groups and partitions diagnostics the validator already computed,
// and the CLI exits 0 whatever it finds. `--waive-file` reuses `em refs`'s waiver file (one line per waiver, `#` comments, missing file = no waivers) so an estate can baseline accepted shapes.

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
  /** Waive-file lines that excused nothing (stale key, unknown rule code). */
  staleWaivers: string[];
}

/** One waive-file line: `<rule-code> <slice-key>` waives that rule's findings under the key; a bare
 *  `<slice-key>` waives every shape rule there. */
interface Waiver { line: string; rule: string | null; key: string; used: boolean }

function parseWaivers(lines: string[], codes: Set<string>): { waivers: Waiver[]; stale: string[] } {
  const waivers: Waiver[] = [];
  const stale: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length === 1) waivers.push({ line, rule: null, key: parts[0], used: false });
    else if (parts.length === 2 && codes.has(parts[0])) waivers.push({ line, rule: parts[0], key: parts[1], used: false });
    else stale.push(line); // unknown rule code, or a malformed line
  }
  return { waivers, stale };
}

const under = (ref: string, key: string) => ref === key || ref.startsWith(`${key}/`);

export function buildShapeReport(diagnostics: Diagnostic[], waiveLines: string[]): ShapeReport {
  const codes = shapeRuleCodes();
  const { waivers, stale } = parseWaivers(waiveLines, new Set<string>(codes));
  const rules: ShapeRuleReport[] = codes.map((code) => {
    const def = RULES[code];
    const findings: Diagnostic[] = [];
    const waived: Diagnostic[] = [];
    for (const d of diagnostics.filter((x) => x.code === code)) {
      const refs = d.refs ?? [];
      // Waived when it has refs and every ref lies under a waiver that applies to this rule.
      const applicable = waivers.filter((w) => w.rule === null || w.rule === code);
      const covering = refs.length === 0 ? null : refs.map((r) => applicable.filter((w) => under(r, w.key)));
      if (covering && covering.every((c) => c.length > 0)) {
        waived.push(d);
        for (const c of covering) for (const w of c) w.used = true;
      } else findings.push(d);
    }
    return { code, title: def.title, docAnchor: (def as { docAnchor?: string }).docAnchor ?? "shape", findings, waived };
  });
  return {
    rules,
    findings: rules.reduce((n, r) => n + r.findings.length, 0),
    waived: rules.reduce((n, r) => n + r.waived.length, 0),
    staleWaivers: [...stale, ...waivers.filter((w) => !w.used).map((w) => w.line)],
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
  out.push("", report.findings === 0 ? "ok — no shape findings" : `${report.findings} shape finding(s) — fix each, or record it as \`shape-accepted: <rule> <refs> — <reason>\` in \`.event-modeling.md\` \`## Decisions log\` (advisory: exit 0)`);
  if (modelErrors > 0) out.push(`note: the model has ${modelErrors} error(s) — run \`em validate\`; shape findings may be incomplete`);
  return out.join("\n");
}
