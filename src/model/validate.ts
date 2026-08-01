// SPDX-License-Identifier: MIT
// Event-modeling rule checks over the normalized model + grid.

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
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
    const commands = slice.elements.filter((e) => e.kind === "command");
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

      // Fields completeness: every view field should trace to a field on some
      // instance of a source event — but only once both sides opt in by declaring
      // `{ fields }`: the view, and *every* source event. A partially-declared
      // source set can't prove a gap (the fieldless event may well provide the
      // field), so it stays silent rather than warning on legitimate fields.
      if (view.fields && view.fields.length > 0) {
        const fromNames = view.from ?? [];
        const sourceEvents: Element[] = [];
        for (const src of fromNames) {
          const bucket = model.byName.get(normalizeName(src)) ?? [];
          for (const e of bucket) if (e.kind === "event") sourceEvents.push(e);
        }
        const sourcesDeclareFields =
          sourceEvents.length > 0 && sourceEvents.every((e) => (e.fields ?? []).length > 0);
        if (sourcesDeclareFields) {
          const fieldUnion = new Set<string>();
          for (const e of sourceEvents) {
            for (const f of e.fields ?? []) fieldUnion.add(normalizeName(f.name));
          }
          const eventList = fromNames.map((n) => `"${n}"`).join(", ");
          for (const f of view.fields) {
            if (!fieldUnion.has(normalizeName(f.name))) {
              diags.push({
                severity: "warning",
                message: `view "${view.name}" field "${f.name}" has no source in ${eventList}`,
                line: view.line,
              });
            }
          }
        }
      }
    }

    // Fields completeness: every event field in a slice should trace to a field on
    // one of that slice's commands (unioned) — again, only once both sides declare
    // `{ fields }`: the event, and *every* command in the slice. A fieldless
    // command may be the field's provider, so a mixed slice stays silent.
    if (commands.length > 0) {
      const commandsDeclareFields = commands.every((c) => (c.fields ?? []).length > 0);
      if (commandsDeclareFields) {
        const commandFieldUnion = new Set<string>();
        for (const c of commands) {
          for (const f of c.fields ?? []) commandFieldUnion.add(normalizeName(f.name));
        }
        const cmdList = commands.map((c) => `"${c.name}"`).join(", ");
        const byCommands = commands.length === 1 ? `command ${cmdList}` : `any of commands ${cmdList}`;
        for (const evt of events) {
          if (!evt.fields || evt.fields.length === 0) continue;
          for (const f of evt.fields) {
            if (!commandFieldUnion.has(normalizeName(f.name))) {
              diags.push({
                severity: "warning",
                message: `event "${evt.name}" field "${f.name}" not provided by ${byCommands}`,
                line: evt.line,
              });
            }
          }
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

  // Something must trigger every command. Information enters the system through a command, and
  // a command enters through a person on a screen or a reaction acting for them — one with
  // neither is a write nobody can start, the input-side mirror of an event nobody reads.
  model.slices.forEach((slice, i) => {
    for (const cmd of slice.elements.filter((e) => e.kind === "command")) {
      if (slice.elements.some((e) => e.kind === "ui")) continue; // State Change: ui -> command
      // Automation/Translation: the reaction sits in the slice before its command.
      const prev = model.slices[i - 1]?.elements ?? [];
      if (prev.some((e) => AUTOMATION_KINDS.has(e.kind))) continue;
      const arrowed = model.arrows.some((a) => {
        const from = a.fromId ? model.byId.get(a.fromId) : undefined;
        return a.toId === cmd.id && !!from && (from.kind === "ui" || AUTOMATION_KINDS.has(from.kind));
      });
      if (arrowed) continue;
      diags.push({
        severity: "warning",
        message:
          `command "${cmd.name}" has nothing that triggers it; add the screen it is issued ` +
          `from (a \`ui\` in this slice) or the reaction that issues it (in the previous slice)`,
        line: cmd.line,
      });
    }
  });

  // Every read model must be consumed. A view nothing displays or watches is the output-side
  // half-slice: information projected out of the system and then dropped on the floor. A
  // complete State View is event -> read model -> ui (or -> reaction, the Automation pattern).
  const consumedViews = new Set<string>();
  for (const el of model.elements) {
    // A reaction's `from` binds to the nearest instance at-or-before it, same as the renderer.
    if (el.kind === "view") continue;
    for (const name of el.from ?? []) {
      const bucket = model.byName.get(normalizeName(name));
      if (!bucket) continue;
      const src =
        bucket
          .filter((x) => x.kind === "view" && x.sliceIndex <= el.sliceIndex)
          .sort((a, b) => b.sliceIndex - a.sliceIndex)[0] ?? bucket.find((x) => x.kind === "view");
      if (src) consumedViews.add(src.id);
    }
  }
  for (const a of model.arrows) {
    if (a.fromId && model.byId.get(a.fromId)?.kind === "view") consumedViews.add(a.fromId);
  }
  for (const slice of model.slices) {
    const consumerInSlice = slice.elements.some(
      (e) => e.kind === "ui" || AUTOMATION_KINDS.has(e.kind),
    );
    if (consumerInSlice) continue;
    for (const view of slice.elements.filter((e) => e.kind === "view")) {
      if (consumedViews.has(view.id)) continue;
      diags.push({
        severity: "warning",
        message:
          `read model "${view.name}" has no consumer; add the screen that displays it ` +
          `(a \`ui\` in this slice) or the reaction that watches it — or drop this instance`,
        line: view.line,
      });
    }
  }

  // Every event must be read by something. Recording an event nothing projects is a write
  // with no reader — the mirror of a command that records no event, and a warning for the
  // same reason: a model in progress legitimately has a write slice whose read slice hasn't
  // been added yet, and errors block rendering (which would break `em watch` mid-session).
  const readEvents = new Set<string>();
  for (const el of model.elements) {
    if (el.kind !== "view") continue;
    const from = el.from ?? [];
    // A view with no `from` reads the events in its own slice (same rule the renderer uses).
    if (from.length) for (const name of from) readEvents.add(normalizeName(name));
    else
      for (const e of model.slices[el.sliceIndex]?.elements ?? []) {
        if (e.kind === "event") readEvents.add(normalizeName(e.name));
      }
  }
  for (const a of model.arrows) {
    const from = a.fromId ? model.byId.get(a.fromId) : undefined;
    const to = a.toId ? model.byId.get(a.toId) : undefined;
    if (from?.kind === "event" && to?.kind === "view") readEvents.add(normalizeName(from.name));
  }
  for (const el of model.elements) {
    if (el.kind !== "event") continue;
    if (readEvents.has(normalizeName(el.name))) continue;
    diags.push({
      severity: "warning",
      message:
        `event "${el.name}" is not read by any read model; project it into a view ` +
        `(\`view X from "${el.name}"\`), or reconsider recording it`,
      line: el.line,
    });
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
      // Inferred edges are legal by construction; a hand-written arrow is the one way an
      // illegal connection can enter a model, so check the kind pair against the patterns.
      if (fromEl && toEl && !isLegalFlow(fromEl.kind, toEl.kind)) {
        diags.push({
          severity: "error",
          message:
            `arrow "${a.from}" -> "${a.to}" connects ${withArticle(fromEl.kind)} directly to ` +
            `${withArticle(toEl.kind)}: ${flowGuidance(fromEl.kind, toEl.kind)}`,
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

  // Open issues (`issue "text"`) are always surfaced as a warning — the red-note
  // device for a question that hasn't been resolved yet.
  for (const el of model.elements) {
    if (el.issue) {
      diags.push({
        severity: "warning",
        message: `open issue on "${el.name}": ${el.issue}`,
        line: el.line,
      });
    }
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

const isAuto = (k: ElementKind) => AUTOMATION_KINDS.has(k);

/** The only kind pairs a connection may take, per the four patterns: information enters the
 *  system through a command and leaves through a read model, and nothing skips a step. */
function isLegalFlow(from: ElementKind, to: ElementKind): boolean {
  if (from === "ui") return to === "command"; // State Change
  if (from === "command") return to === "event"; // State Change
  if (from === "event") return to === "view"; // State View
  if (from === "view") return to === "ui" || isAuto(to); // State View / Automation / Translation
  if (isAuto(from)) return to === "command"; // reactions always go through a command
  return false;
}

/** Why a given illegal pair is illegal, and what to put in the gap. */
function flowGuidance(from: ElementKind, to: ElementKind): string {
  if (from === "command" && to === "view")
    return "an event has to sit between them (command -> event -> read model)";
  if (from === "view" && to === "command")
    return "a reaction has to sit between them (read model -> processor -> command), split across two slices";
  if (from === "event" && to === "command")
    return "project the event into a read model a reaction watches (event -> read model -> processor -> command)";
  if (from === "event" && to === "event")
    return "events never connect to events; each one is recorded by a command";
  if (from === "view" && to === "view")
    return "instances of one read model are never connected; repeat it with `view X again` and let its events show the change";
  if (from === "command" && to === "command")
    return "commands never chain; record the event, then react to it";
  if (isAuto(from) && to === "event")
    return "a reaction never records an event itself; route it through a command (reaction -> command -> event)";
  if (to === "ui" && from !== "view")
    return "a screen is fed by a read model (event -> read model -> ui)";
  return (
    "the patterns allow only ui -> command -> event -> read model -> ui, " +
    "plus read model -> reaction -> command"
  );
}

function kindLabel(kind: ElementKind): string {
  return kind === "view" ? "read model" : kind === "ui" ? "screen" : kind;
}

function withArticle(kind: ElementKind): string {
  const label = kindLabel(kind);
  return `${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`;
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