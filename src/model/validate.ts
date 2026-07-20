// SPDX-License-Identifier: MIT
// Event-modeling rule checks over the normalized model + grid.

import { AUTOMATION_KINDS } from "../parser/ast.js";
import { Grid } from "../layout/grid.js";
import { Element, NormalizedModel, normalizeName } from "./model.js";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  message: string;
  line?: number;
  /** Slice-doc path, for diagnostics that point at a Markdown doc rather than a .em line. */
  file?: string;
}

export function validate(model: NormalizedModel, grid: Grid): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Grid collisions: two elements of the same band landed in one slice cell.
  for (const c of grid.collisions) {
    diags.push({
      severity: "error",
      message:
        `"${c.dropped.name}" collides with "${c.kept.name}" in the same ` +
        `slice/lane (${c.rowKey}); split them into separate slices`,
      line: c.dropped.line,
    });
  }

  for (const slice of model.slices) {
    const command = slice.elements.find((e) => e.kind === "command");
    const events = slice.elements.filter((e) => e.kind === "event");
    const views = slice.elements.filter((e) => e.kind === "view");
    const auto = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));

    // An automation/translation slice holds only the read model + the
    // automation; the command it triggers belongs in the next slice.
    if (auto && command) {
      diags.push({
        severity: "warning",
        message:
          `${auto.kind} "${auto.name}" shares slice "${slice.name}" with command ` +
          `"${command.name}"; put the triggered command in the next slice`,
        line: command.line,
      });
    }

    // A command should record at least one event.
    if (command && events.length === 0) {
      diags.push({
        severity: "warning",
        message: `command "${command.name}" produces no event in slice "${slice.name}"`,
        line: command.line,
      });
    }

    // A read model must derive from at least one event.
    for (const view of views) {
      const hasFrom = (view.from ?? []).length > 0;
      if (!hasFrom && events.length === 0) {
        diags.push({
          severity: "warning",
          message:
            `read model "${view.name}" has no source event ` +
            `(add \`from "Event"\` or place it in a slice with an event)`,
          line: view.line,
        });
      }
      for (const src of view.from ?? []) {
        const bucket = model.byName.get(normalizeName(src));
        const evt = bucket?.find((e) => e.kind === "event");
        if (!evt) {
          diags.push({
            severity: "error",
            message: `read model "${view.name}" references unknown event "${src}"`,
            line: view.line,
          });
        } else if (evt.sliceIndex > view.sliceIndex) {
          diags.push({
            severity: "error",
            message:
              `time flows left to right: event "${evt.name}" (slice ${evt.sliceIndex + 1}) happens ` +
              `after read model "${view.name}" (slice ${view.sliceIndex + 1}); move this source to a ` +
              `later \`view ${view.name} again\` instance`,
            line: view.line,
          });
        }
      }
    }
  }

  // Automation/translation consumes a read model via `from` — and must read one that
  // already exists on the timeline (forward-only).
  for (const el of model.elements) {
    if (!AUTOMATION_KINDS.has(el.kind)) continue;
    for (const src of el.from ?? []) {
      const bucket = model.byName.get(normalizeName(src));
      const views = bucket?.filter((e) => e.kind === "view") ?? [];
      if (views.length === 0) {
        diags.push({
          severity: "error",
          message: `${el.kind} "${el.name}" references unknown read model "${src}"`,
          line: el.line,
        });
      } else if (!views.some((v) => v.sliceIndex <= el.sliceIndex)) {
        diags.push({
          severity: "error",
          message:
            `time flows left to right: ${el.kind} "${el.name}" (slice ${el.sliceIndex + 1}) reads ` +
            `"${src}" before any instance of it exists; declare the view in or before that slice`,
          line: el.line,
        });
      }
    }
  }

  // A \`view X again\` instance needs an earlier declaration to continue.
  for (const el of model.elements) {
    if (el.kind === "view" && el.again && el.logicalId === el.id) {
      diags.push({
        severity: "error",
        message:
          `view "${el.name}" is marked \`again\` but has no earlier declaration; ` +
          `declare it plainly the first time it appears`,
        line: el.line,
      });
    }
  }

  // Explicit arrow endpoints must resolve — and point forward.
  for (const a of model.arrows) {
    if (a.fromId && a.toId) {
      const fromEl = model.byId.get(a.fromId);
      const toEl = model.byId.get(a.toId);
      if (fromEl && toEl && toEl.sliceIndex < fromEl.sliceIndex) {
        diags.push({
          severity: "error",
          message:
            `time flows left to right: arrow "${a.from}" -> "${a.to}" points backward ` +
            `(slice ${fromEl.sliceIndex + 1} -> ${toEl.sliceIndex + 1}); restructure so the target comes later`,
          line: a.line,
        });
      }
    }
    if (!a.fromId)
      diags.push({
        severity: "error",
        message: `arrow source "${a.from}" does not match any element`,
        line: a.line,
      });
    if (!a.toId)
      diags.push({
        severity: "error",
        message: `arrow target "${a.to}" does not match any element`,
        line: a.line,
      });
  }

  // Ambiguous names (used by arrows / view sources) get a heads-up.
  for (const [key, els] of model.byName) {
    // Later \`again\` instances of a view are the SAME logical read model reappearing on the
    // timeline — deliberate, not an ambiguity. Only warn when a duplicate is NOT an instance.
    const nonInstances = els.filter((e, i) => i === 0 || !(e.kind === "view" && e.again));
    if (nonInstances.length > 1 && isReferenced(model, key)) {
      diags.push({
        severity: "warning",
        message:
          `name "${els[0].name}" is defined ${nonInstances.length} times; ` +
          `references resolve to the first occurrence`,
        line: els[0].line,
      });
    }
  }

  return diags;
}

function isReferenced(model: NormalizedModel, key: string): boolean {
  for (const a of model.arrows) {
    if (normalizeName(a.from) === key || normalizeName(a.to) === key) return true;
  }
  for (const el of model.elements) {
    for (const f of el.from ?? []) if (normalizeName(f) === key) return true;
  }
  return false;
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}

/** Pretty one-line diagnostic for terminal output. */
export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? ` ${d.file}` : d.line ? `:${d.line}` : "";
  const tag = d.severity === "error" ? "error" : "warn ";
  return `  ${tag}${where} ${d.message}`;
}

export type { Element };