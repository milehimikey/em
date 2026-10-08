// SPDX-License-Identifier: MIT
// Generated regions of a slice doc (MIL-266): the parts of `slices/<key>.md` that restate the
// model — each command's field table, each event's payload table, each read model's field table,
// and the slice's model-declared invariants — become marker-delimited regions whose bodies `em`
// writes from the `.em` and keeps in step (`em slice new` fills them, `em slice sync` refreshes
// them in place). Every other section stays authored and is never touched.
//
//   <!-- GENERATED:em-slice-command:start — … -->
//   **Command:** `Submit Order`
//
//   | Field | Type | Required | Rules / Validation |
//   …
//   <!-- GENERATED:em-slice-command:end -->
//
// Region names: `em-slice-command`, `em-slice-event`, `em-slice-view`, `em-slice-invariants`.
// When a slice (or the union of slices a doc is bound to) has several elements of one kind, each
// gets its own region, suffixed with the element's kebab slug (`em-slice-event-order-placed`).
// A kind with no element still gets its one un-suffixed region, holding a one-line "none" note,
// so adding the first element to the model later is a plain `em slice sync`.
//
// The `**Command:**` / `**Event:**` / `- **View:**` marker lines sit INSIDE the regions, so
// catalog/docModelConsistencyValidate.ts keeps reading them exactly as before.
//
// Pure: model in, region bodies (as line arrays, EOL-free) out; doc text in, regions/problems
// out. The CLI (`em slice new`, cli/sliceSync.ts) owns every read and write.

import { Element, NormalizedModel, normalizeName } from "../model/model.js";
import { kebabSlug } from "../util/slug.js";
import { parseScenarios } from "./scenarios.js";

export const SLICE_REGION_PREFIX = "em-slice-";

export type RegionKind = "command" | "event" | "view" | "invariants";

/** The template's table header for each element kind's generated field table — the exact
 *  header `slice-doc/structured-section-malformed` compares a region's table against. */
export const REGION_TABLE_HEADERS: Record<"command" | "event" | "view", readonly string[]> = {
  command: ["Field", "Type", "Required", "Rules / Validation"],
  event: ["Field", "Type", "Immutable Fact?", "Source / Notes"],
  view: ["Field", "Type", "Source / Notes"],
};

/** Trailing prose on every region's start marker line — preserved verbatim by `em slice sync`. */
export const REGION_START_NOTE = "generated from the model by `em slice sync`; do not hand-edit";

/** The comment `em slice new` and the template put right after the Invariants region. */
export const INVARIANTS_ELABORATE_COMMENT = "<!-- elaborate below this list; IDs are declared in the model -->";

export interface GeneratedRegion {
  name: string;
  kind: RegionKind;
  /** Body lines, without the marker lines and without EOLs. */
  body: string[];
}

export function regionStartLine(name: string): string {
  return `<!-- GENERATED:${name}:start — ${REGION_START_NOTE} -->`;
}

export function regionEndLine(name: string): string {
  return `<!-- GENERATED:${name}:end -->`;
}

/** The region kind a region name belongs to, or null for a name outside the vocabulary. */
export function regionKindOf(name: string): RegionKind | null {
  const m = /^em-slice-(command|event|view|invariants)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(name);
  if (!m) return null;
  if (m[1] === "invariants" && name !== "em-slice-invariants") return null;
  return m[1] as RegionKind;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function tableHeader(kind: "command" | "event" | "view"): string[] {
  const cols = REGION_TABLE_HEADERS[kind];
  return [`| ${cols.join(" | ")} |`, `|${cols.map((c) => "-".repeat(c.length + 2)).join("|")}|`];
}

const NO_FIELDS = "_No fields declared in the model._";

function commandBody(_model: NormalizedModel, el: Element): string[] {
  const out = [`**Command:** \`${el.name}\``, ""];
  if (!el.fields || el.fields.length === 0) return [...out, NO_FIELDS];
  out.push(...tableHeader("command"));
  for (const f of el.fields) {
    const notes: string[] = [];
    if (f.renamedFrom && f.renamedFrom.length > 0) notes.push(`renamed from ${f.renamedFrom.map((n) => `"${n}"`).join(", ")}`);
    out.push(
      `| ${cell(f.name)} | ${cell(f.type ?? "—")} | ${f.optional === true ? "no" : "yes"} | ${cell(notes.join("; ") || "—")} |`,
    );
  }
  return out;
}

function eventBody(model: NormalizedModel, el: Element): string[] {
  const head = el.context ? `**Event:** \`${el.name}\` → context \`${el.context}\`` : `**Event:** \`${el.name}\``;
  const out = [head, ""];
  if (!el.fields || el.fields.length === 0) return [...out, NO_FIELDS];
  out.push(...tableHeader("event"));
  const commands = model.slices[el.sliceIndex].elements.filter((e) => e.kind === "command");
  for (const f of el.fields) {
    const notes: string[] = [];
    if (f.assigned === true) {
      notes.push("assigned (set by the handler)");
    } else {
      const src = commands.find((c) => (c.fields ?? []).some((cf) => normalizeName(cf.name) === normalizeName(f.name)));
      notes.push(src ? `from command \`${src.name}\`` : "{{ }}");
    }
    if (f.tag === true) notes.push("identity tag");
    if (f.optional === true) notes.push("optional");
    if (f.renamedFrom && f.renamedFrom.length > 0) notes.push(`renamed from ${f.renamedFrom.map((n) => `"${n}"`).join(", ")}`);
    out.push(`| ${cell(f.name)} | ${cell(f.type ?? "—")} | yes | ${cell(notes.join("; "))} |`);
  }
  return out;
}

function viewBody(model: NormalizedModel, el: Element): string[] {
  const sources = el.from ?? [];
  const built = sources.length > 0 ? sources.map((s) => `"${s}"`).join(", ") : "—";
  const out = [`- **View:** \`${el.name}\` built from events: ${built}`, ""];
  if (!el.fields || el.fields.length === 0) return [...out, NO_FIELDS];
  out.push(...tableHeader("view"));
  const sourceEvents: Element[] = [];
  for (const s of sources) {
    const ev = (model.byName.get(normalizeName(s)) ?? []).find((e) => e.kind === "event");
    if (ev) sourceEvents.push(ev);
  }
  for (const f of el.fields) {
    let note: string;
    if (f.derived === true) {
      note = f.derivedFrom && f.derivedFrom.length > 0 ? `Derived from ${f.derivedFrom.map((n) => `"${n}"`).join(", ")}` : "Derived";
    } else {
      const src = sourceEvents.find((ev) => (ev.fields ?? []).some((ef) => normalizeName(ef.name) === normalizeName(f.name)));
      note = src ? `from event \`${src.name}\`` : "{{ }}";
    }
    out.push(`| ${cell(f.name)} | ${cell(f.type ?? "—")} | ${cell(note)} |`);
  }
  return out;
}

function noneBody(kind: "command" | "event" | "view"): string[] {
  const word = kind === "view" ? "read model" : kind;
  return [`_This slice has no ${word} in the model._`];
}

/**
 * The generated regions a doc bound to `sliceIndices` (one slice, or the union a MIL-121
 * cross-covered doc / a MIL-208 continuation resolves to) should carry, in template order:
 * commands, events, views, invariants. Elements are taken in slice order then declaration
 * order; a repeated view (`again`) contributes only its first instance, and two elements of one
 * kind with the same slug only the first.
 */
export function buildSliceRegions(model: NormalizedModel, sliceIndices: number[]): GeneratedRegion[] {
  const ordered = [...sliceIndices].sort((a, b) => a - b);
  const elements: Element[] = [];
  for (const i of ordered) elements.push(...model.slices[i].elements);

  const regions: GeneratedRegion[] = [];
  for (const kind of ["command", "event", "view"] as const) {
    const seenLogical = new Set<string>();
    const seenSlug = new Set<string>();
    const els: Element[] = [];
    for (const el of elements) {
      if (el.kind !== kind) continue;
      if (seenLogical.has(el.logicalId)) continue;
      seenLogical.add(el.logicalId);
      const s = kebabSlug(el.name);
      if (seenSlug.has(s)) continue;
      seenSlug.add(s);
      els.push(el);
    }
    const build = kind === "command" ? commandBody : kind === "event" ? eventBody : viewBody;
    if (els.length === 0) {
      regions.push({ name: `${SLICE_REGION_PREFIX}${kind}`, kind, body: noneBody(kind) });
    } else if (els.length === 1) {
      regions.push({ name: `${SLICE_REGION_PREFIX}${kind}`, kind, body: build(model, els[0]) });
    } else {
      for (const el of els) regions.push({ name: `${SLICE_REGION_PREFIX}${kind}-${kebabSlug(el.name)}`, kind, body: build(model, el) });
    }
  }

  const invLines: string[] = [];
  for (const el of elements) {
    if (el.kind !== "command" && el.kind !== "event") continue;
    for (const inv of el.invariants ?? []) {
      // `**INV-X**` + an em-dash — deliberately NOT the `**INV-X:**` declaring label
      // (invariants/declared-in-both): the model declares the ID, this list only restates it.
      invLines.push(inv.rule ? `- **${inv.id}** — ${inv.rule}` : `- **${inv.id}**`);
    }
  }
  regions.push({
    name: `${SLICE_REGION_PREFIX}invariants`,
    kind: "invariants",
    body: invLines.length > 0 ? invLines : ["_No invariants declared in the model._"],
  });
  return regions;
}

/** The template's placeholder regions — what `em slice new` writes when it has no model to fill
 *  them from (no `--wire`). `em slice sync` fills them once the doc is bound. */
export function placeholderRegions(): GeneratedRegion[] {
  return [
    {
      name: "em-slice-command",
      kind: "command",
      body: [
        "**Command:** `{{Command Name}}`",
        "",
        ...tableHeader("command"),
        "| {{field}} | {{Type}} | {{yes/no}} | {{constraints, formats, ranges}} |",
      ],
    },
    {
      name: "em-slice-event",
      kind: "event",
      body: [
        "**Event:** `{{Event Name}}` → context `{{Context}}`",
        "",
        ...tableHeader("event"),
        "| {{field}} | {{Type}} | {{yes/no}} | {{where the value comes from}} |",
      ],
    },
    {
      name: "em-slice-view",
      kind: "view",
      body: [
        '- **View:** `{{View Name}}` built from events: {{"Event A", "Event B"}}',
        "",
        ...tableHeader("view"),
        "| {{field}} | {{Type}} | {{which event field it's copied from, or `Derived: <rule>`}} |",
      ],
    },
    {
      name: "em-slice-invariants",
      kind: "invariants",
      body: ['- **INV-{{MNEMONIC}}-1** — {{rule, as declared by `invariant INV-{{MNEMONIC}}-1 "rule"` in the model}}'],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Reading regions back out of a doc.

export interface RegionSpan {
  name: string;
  /** Offset of the first byte AFTER the start marker line's text (its EOL starts here). */
  innerStart: number;
  /** Offset of the first byte of the end marker line. */
  innerEnd: number;
  /** The text between the two marker lines, without the EOL that ends the start line and the
   *  EOL before the end line — the region's body. */
  body: string;
}

export interface RegionScan {
  regions: RegionSpan[];
  /** Balance problems; when non-empty, `regions` must not be rewritten. */
  problems: string[];
}

const MARKER_LINE_RE = /^<!-- GENERATED:(em-slice-[A-Za-z0-9-]+):(start|end)\b[^\r\n]*$/gm;

/** Find every `em-slice-*` region in `text` (a whole doc or its body), checking that markers are
 *  balanced: every start has its end, no region opens inside another, and no name repeats. */
export function scanSliceRegions(text: string): RegionScan {
  const regions: RegionSpan[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let open: { name: string; innerStart: number } | null = null;
  for (const m of text.matchAll(MARKER_LINE_RE)) {
    const name = m[1];
    const which = m[2];
    const lineStart = m.index!;
    if (which === "start") {
      if (open) {
        problems.push(`region "${name}" starts inside region "${open.name}" (no end marker for "${open.name}" before it)`);
        open = null;
      }
      if (seen.has(name)) problems.push(`region "${name}" appears more than once`);
      seen.add(name);
      if (regionKindOf(name) === null) problems.push(`region "${name}" is not a known generated region (em-slice-command|event|view[-<slug>], em-slice-invariants)`);
      open = { name, innerStart: lineStart + m[0].length };
    } else {
      if (!open) {
        problems.push(`end marker for region "${name}" has no start marker`);
        continue;
      }
      if (open.name !== name) {
        problems.push(`region "${open.name}" is closed by the end marker of "${name}"`);
        open = null;
        continue;
      }
      const raw = text.slice(open.innerStart, lineStart);
      const body = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      regions.push({ name, innerStart: open.innerStart, innerEnd: lineStart, body });
      open = null;
    }
  }
  if (open) problems.push(`region "${open.name}" has no end marker`);
  return { regions, problems };
}

function splitCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** A field-table region's header problem, or null when its first table's header matches the
 *  template's (or the region holds no table at all — an element with no fields). */
function tableHeaderProblem(region: RegionSpan): string | null {
  const kind = regionKindOf(region.name);
  if (kind === null || kind === "invariants") return null;
  const lines = region.body.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|/.test(lines[i + 1])) continue;
    if (!splitCells(lines[i + 1]).every((c) => /^:?-+:?$/.test(c))) continue;
    const got = splitCells(lines[i]);
    const want = REGION_TABLE_HEADERS[kind];
    if (got.length === want.length && got.every((c, j) => c === want[j])) return null;
    return `region "${region.name}"'s table header is "| ${got.join(" | ")} |" — expected "| ${want.join(" | ")} |"`;
  }
  return null;
}

/**
 * Every structural problem in a slice doc's generated regions and authored scenarios — the facts
 * behind `slice-doc/structured-section-malformed` and its `--slice-ready` twin. Empty for a doc
 * with no `em-slice-*` markers and no `### Scenario:` blocks (every 1.13-style doc).
 */
export function findStructuredSectionProblems(body: string): string[] {
  const scan = scanSliceRegions(body);
  const problems = [...scan.problems];
  if (scan.problems.length === 0) {
    for (const region of scan.regions) {
      const p = tableHeaderProblem(region);
      if (p) problems.push(p);
    }
  }
  problems.push(...parseScenarios(body).problems);
  return problems;
}
