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
        }
      }
    }
  }

  // Automation/translation consumes a read model via `from`.
  for (const el of model.elements) {
    if (!AUTOMATION_KINDS.has(el.kind)) continue;
    for (const src of el.from ?? []) {
      const bucket = model.byName.get(normalizeName(src));
      if (!bucket?.some((e) => e.kind === "view")) {
        diags.push({
          severity: "error",
          message: `${el.kind} "${el.name}" references unknown read model "${src}"`,
          line: el.line,
        });
      }
    }
  }

  // Explicit arrow endpoints must resolve.
  for (const a of model.arrows) {
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
    if (els.length > 1 && isReferenced(model, key)) {
      diags.push({
        severity: "warning",
        message:
          `name "${els[0].name}" is defined ${els.length} times; ` +
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
  const where = d.line ? `:${d.line}` : "";
  const tag = d.severity === "error" ? "error" : "warn ";
  return `  ${tag}${where} ${d.message}`;
}

export type { Element };