// SPDX-License-Identifier: MIT
// Human-text formatting for `em query`'s eight verbs (the default output — `--json` bypasses
// this entirely and prints `emit/queryJson.ts`'s document instead). An empty `results` array
// always prints a bare `(none)` line and still exits 0 — a query with a legitimately empty
// answer (an event nobody consumes, two elements with no path between them) is not an error.

import {
  ConsumerEntry,
  ProducerEntry,
  ClosureEntry,
  SliceQueryEntry,
  InvariantQueryEntry,
  FieldQueryEntry,
  PathQueryEntry,
} from "./verbs.js";

function tagList(label: string, items: string[]): string {
  return items.length > 0 ? ` ${label}=[${items.join(", ")}]` : "";
}

export function formatConsumers(results: ConsumerEntry[]): string {
  if (results.length === 0) return "(none)";
  return results.map((r) => `${r.ref}  (${r.kind}) in slice "${r.sliceName}" [${r.sliceKey}] — via ${r.via}`).join("\n");
}

export function formatProducers(results: ProducerEntry[]): string {
  if (results.length === 0) return "(none)";
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.ref}  (${r.kind}) in slice "${r.sliceName}" [${r.sliceKey}] — via ${r.via}`);
    for (const t of r.uiTriggers) lines.push(`  triggered by ui: ${t.ref}  "${t.name}"`);
  }
  return lines.join("\n");
}

export function formatClosure(results: ClosureEntry[]): string {
  if (results.length === 0) return "(none)";
  return results.map((r) => `depth ${r.depth}  ${r.ref}  (${r.kind}) via ${r.via} — slice "${r.sliceName}" [${r.sliceKey}]`).join("\n");
}

export function formatSlices(results: SliceQueryEntry[]): string {
  if (results.length === 0) return "(none)";
  return results
    .map(
      (r) =>
        `${r.ref}  "${r.name}"  pattern=${r.pattern} status=${r.status ?? "no-doc"}` +
        tagList("personas", r.personas) +
        tagList("contexts", r.contexts) +
        tagList("tags", r.tags),
    )
    .join("\n");
}

export function formatInvariant(results: InvariantQueryEntry[]): string {
  if (results.length === 0) return "(none)";
  const r = results[0];
  const lines = [
    `${r.id}  declared in slice "${r.sliceName}" [${r.sliceRef}]`,
    `  doc: ${r.docPath ?? "(no doc)"}  status: ${r.status ?? "(none)"}`,
  ];
  if (r.citations !== null) {
    if (r.citations.length === 0) lines.push("  citations: (none)");
    else {
      lines.push("  citations:");
      for (const c of r.citations) lines.push(`    ${c.file}:${c.line}`);
    }
  }
  return lines.join("\n");
}

export function formatField(results: FieldQueryEntry[]): string {
  if (results.length === 0) return "(none)";
  const r = results[0];
  const renamed = r.renamedFrom && r.renamedFrom.length > 0 ? ` renamedFrom=[${r.renamedFrom.join(", ")}]` : "";
  return `${r.elementRef}.${r.name}: ${r.type ?? "(untyped)"} tag=${r.tag} assigned=${r.assigned}${renamed}`;
}

export function formatPath(results: PathQueryEntry[]): string {
  if (results.length === 0) return "(none)";
  const r = results[0];
  if (r.length === 0) return r.refs[0];
  const parts: string[] = [r.refs[0]];
  for (let i = 0; i < r.edgeKinds.length; i++) {
    parts.push(`--[${r.edgeKinds[i]}]-->`);
    parts.push(r.refs[i + 1]);
  }
  return parts.join(" ");
}
