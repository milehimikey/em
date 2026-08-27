// SPDX-License-Identifier: MIT
// Event-modeling rule checks over the normalized model + grid.

import { AUTOMATION_KINDS, ElementKind } from "../parser/ast.js";
import { Grid } from "../layout/grid.js";
import { collectTags, Element, NormalizedModel, TypeDecl, normalizeName, resolveTypeRef } from "./model.js";
import { pushDiag } from "./rules.js";
import type { RefsResult } from "./refs.js";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** Stable, CI-matchable rule identifier (MIL-91) — the contract; `message` is prose and may
   *  be reworded freely. One code per distinct rule; nested under a docs/validation.md H3
   *  anchor (`both-ends-of-a-flow/...`, `fields-completeness/...`, `connection-legality/...`)
   *  where one exists and covers more than one rule. */
  code: string;
  message: string;
  line?: number;
  /** Export-stable refs/keys (from `computeRefs()`) of every entity this diagnostic concerns —
   *  0, 1, or more (e.g. a duplicate-name collision concerns two elements). Omitted, not `[]`,
   *  at sites with no specific entity to point at. Never a second identifier scheme — always
   *  sourced from the same `RefsResult` `em export`/`em diff` use. */
  refs?: string[];
}

export function validate(model: NormalizedModel, grid: Grid, refs: RefsResult): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const refOf = (id: string): string => refs.refById.get(id)!;

  // Grid collisions: two elements of the same band landed in one slice cell.
  for (const c of grid.collisions) {
    pushDiag(diags, "grid-collision", {
      message:
        `"${c.dropped.name}" collides with "${c.kept.name}" in the same ` +
        `slice/lane (${c.rowKey}); split them into separate slices`,
      line: c.dropped.line,
      refs: [refOf(c.dropped.id), refOf(c.kept.id)],
    });
  }

  for (const slice of model.slices) {
    const command = slice.elements.find((e) => e.kind === "command");
    const commands = slice.elements.filter((e) => e.kind === "command");
    const events = slice.elements.filter((e) => e.kind === "event");
    const views = slice.elements.filter((e) => e.kind === "view");
    const auto = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));

    // An automation/translation triggers its command in the same slice — the reaction is
    // to a command what a `ui` is in the State Change pattern, just in the automation band
    // instead of a persona row. An explicit arrow to a command elsewhere also counts (see
    // the command-untriggered check below for the symmetric case); this is the other half
    // of that same completeness pair, checked in the block below alongside `event-unproduced`.

    // A `ui` only ever triggers a `command` (State Change) — no pattern has a `ui`
    // triggering a reaction. If one sits in a reaction's slice, with no read model in the
    // same slice, it renders with no outgoing edge at all: a floating box nothing points
    // at — true whether or not that slice already has the reaction's own command. But a
    // `view` in the same slice draws `view -> ui` regardless of whether an automation also
    // reads it (edges.ts) — that ui IS connected, so stay quiet.
    if (auto && views.length === 0) {
      for (const ui of slice.elements.filter((e) => e.kind === "ui")) {
        pushDiag(diags, "ui-shares-slice-with-automation", {
          message:
            `ui "${ui.name}" shares slice "${slice.name}" with ${auto.kind} "${auto.name}"; ` +
            `a \`ui\` only wires to a \`command\` a person issues and renders disconnected here — ` +
            `move it to the slice that displays the read model, or drop it`,
          line: ui.line,
          refs: [refOf(ui.id), refOf(auto.id)],
        });
      }
    }

    // A command should record at least one event.
    if (command && events.length === 0) {
      pushDiag(diags, "both-ends-of-a-flow/command-no-event", {
        message: `command "${command.name}" produces no event in slice "${slice.name}"`,
        line: command.line,
        refs: [refOf(command.id)],
      });
    }

    // A read model must derive from at least one event.
    for (const view of views) {
      const hasFrom = (view.from ?? []).length > 0;
      if (!hasFrom && events.length === 0) {
        pushDiag(diags, "view-no-source", {
          message:
            `read model "${view.name}" has no source event ` +
            `(add \`from "Event"\` or place it in a slice with an event)`,
          line: view.line,
          refs: [refOf(view.id)],
        });
      }
      for (const src of view.from ?? []) {
        const bucket = model.byName.get(normalizeName(src));
        const evt = bucket?.find((e) => e.kind === "event");
        if (!evt) {
          // Same courtesy as the reaction check below: if the name exists as
          // another kind, say so rather than calling it unknown.
          const other = bucket?.[0];
          pushDiag(diags, "view-from-unresolved", {
            message: other
              ? `read model "${view.name}" references "${src}", which is a ${other.kind}, not an event — ` +
                `\`from\` on a view names the events it projects`
              : `read model "${view.name}" references unknown event "${src}"`,
            line: view.line,
            refs: other ? [refOf(view.id), refOf(other.id)] : [refOf(view.id)],
          });
        } else if (evt.sliceIndex > view.sliceIndex) {
          pushDiag(diags, "view-from-future-event", {
            message:
              `time flows left to right: event "${evt.name}" (slice ${evt.sliceIndex + 1}) happens ` +
              `after read model "${view.name}" (slice ${view.sliceIndex + 1}); move this source to a ` +
              `later \`view ${view.name} again\` instance`,
            line: view.line,
            refs: [refOf(view.id), refOf(evt.id)],
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
              pushDiag(diags, "fields-completeness/view-field-no-source", {
                message: `view "${view.name}" field "${f.name}" has no source in ${eventList}`,
                line: view.line,
                refs: [refOf(view.id), ...sourceEvents.map((e) => refOf(e.id))],
              });
            }
          }
        }
      }
    }

    // Fields completeness: every event field in a slice should trace to a field on
    // one of that slice's commands (unioned) — again, only once both sides declare
    // `{ fields }`: the event, and *every* command in the slice. A fieldless
    // command may be the field's provider, so a mixed slice stays silent. A field
    // marked `assigned` (MIL-148) opts out of this check entirely — it's the
    // model's own record that the server/handler sets the field, not the command.
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
            // `assigned` fields (MIL-148) are system-assigned — set by the server/handler,
            // never supplied by the triggering command — so they never trace to a command
            // field and never warn here. They stay fully visible to the view↔event check
            // above, which is a separate loop this one doesn't touch.
            if (f.assigned) continue;
            if (!commandFieldUnion.has(normalizeName(f.name))) {
              pushDiag(diags, "fields-completeness/event-field-no-source", {
                message: `event "${evt.name}" field "${f.name}" not provided by ${byCommands}`,
                line: evt.line,
                refs: [refOf(evt.id), ...commands.map((c) => refOf(c.id))],
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
        // A name that exists but as the wrong kind reads like a typo without
        // saying so — call out the kind mismatch and the fix (project the
        // event into a view) instead of claiming the name is unknown.
        const asEvent = bucket?.find((e) => e.kind === "event");
        pushDiag(diags, "reaction-from-unresolved", {
          message: asEvent
            ? `${el.kind} "${el.name}" references "${src}", which is an event, not a read model — ` +
              `reactions watch read models; project the event into a view first ` +
              `(\`view <Pending Work> from "${src}"\`) and reference that view`
            : `${el.kind} "${el.name}" references unknown read model "${src}"`,
          line: el.line,
          refs: asEvent ? [refOf(el.id), refOf(asEvent.id)] : [refOf(el.id)],
        });
      } else if (!views.some((v) => v.sliceIndex <= el.sliceIndex)) {
        pushDiag(diags, "reaction-from-future-view", {
          message:
            `time flows left to right: ${el.kind} "${el.name}" (slice ${el.sliceIndex + 1}) reads ` +
            `"${src}" before any instance of it exists; declare the view in or before that slice`,
          line: el.line,
          refs: [refOf(el.id)],
        });
      }
    }
  }

  // A \`view X again\` instance needs an earlier declaration to continue.
  for (const el of model.elements) {
    if (el.kind === "view" && el.again && el.logicalId === el.id) {
      pushDiag(diags, "view-again-without-earlier", {
        message:
          `view "${el.name}" is marked \`again\` but has no earlier declaration; ` +
          `declare it plainly the first time it appears`,
        line: el.line,
        refs: [refOf(el.id)],
      });
    }
  }

  // Something must trigger every command. Information enters the system through a command, and
  // a command enters through a person on a screen or a reaction acting for them — one with
  // neither is a write nobody can start, the input-side mirror of an event nobody reads.
  for (const slice of model.slices) {
    for (const cmd of slice.elements.filter((e) => e.kind === "command")) {
      if (slice.elements.some((e) => e.kind === "ui")) continue; // State Change: ui -> command
      // Automation/Translation: the reaction triggers the command in this same slice.
      if (slice.elements.some((e) => AUTOMATION_KINDS.has(e.kind))) continue;
      const arrowed = model.arrows.some((a) => {
        const from = a.fromId ? model.byId.get(a.fromId) : undefined;
        return a.toId === cmd.id && !!from && (from.kind === "ui" || AUTOMATION_KINDS.has(from.kind));
      });
      if (arrowed) continue;
      pushDiag(diags, "both-ends-of-a-flow/command-untriggered", {
        message:
          `command "${cmd.name}" has nothing that triggers it; add the screen it is issued ` +
          `from (a \`ui\` in this slice) or the reaction that issues it (also in this slice)`,
        line: cmd.line,
        refs: [refOf(cmd.id)],
      });
    }
  }

  // The mirror case: a reaction that triggers no command. A processor/translation never
  // records an event itself (isLegalFlow allows no other producer downstream of a reaction
  // but a command) — one with no command in its slice and no explicit arrow to one is a
  // decision the system never acts on.
  for (const slice of model.slices) {
    for (const auto of slice.elements.filter((e) => AUTOMATION_KINDS.has(e.kind))) {
      if (slice.elements.some((e) => e.kind === "command")) continue;
      const arrowed = model.arrows.some((a) => {
        const to = a.toId ? model.byId.get(a.toId) : undefined;
        return a.fromId === auto.id && to?.kind === "command";
      });
      if (arrowed) continue;
      pushDiag(diags, "both-ends-of-a-flow/reaction-no-command", {
        message:
          `${auto.kind} "${auto.name}" triggers no command; add the command it issues ` +
          `(in this slice) or an explicit arrow to one`,
        line: auto.line,
        refs: [refOf(auto.id)],
      });
    }
  }

  // Something must produce every event. An event is only ever recorded by a command
  // (isLegalFlow allows no other producer) — one with no command in its slice and no
  // explicit arrow from one is a fact on the timeline with no traceable cause, the
  // record-side mirror of a command nothing triggers.
  for (const slice of model.slices) {
    if (slice.elements.some((e) => e.kind === "command")) continue;
    for (const evt of slice.elements.filter((e) => e.kind === "event")) {
      const arrowed = model.arrows.some((a) => {
        const from = a.fromId ? model.byId.get(a.fromId) : undefined;
        return a.toId === evt.id && from?.kind === "command";
      });
      if (arrowed) continue;
      pushDiag(diags, "both-ends-of-a-flow/event-unproduced", {
        message:
          `event "${evt.name}" has no producing command; add the command that records it ` +
          `(in this slice) or an explicit arrow from one`,
        line: evt.line,
        refs: [refOf(evt.id)],
      });
    }
  }

  // Every screen needs something behind it: a read model to display (State View,
  // view -> ui) or a command to issue (State Change, ui -> command). A `ui` with neither
  // is a screen modeled with nothing driving it — commonly a GET endpoint quietly dropped
  // during extraction because it doesn't fit the "each endpoint is a command" framing.
  // The reaction-slice case (a `ui` misplaced in an automation's slice with no read model)
  // already gets its own, more specific diagnostic above — skip it here to avoid a
  // duplicate warning for the same root cause.
  for (const slice of model.slices) {
    const autoInSlice = slice.elements.find((e) => AUTOMATION_KINDS.has(e.kind));
    const hasViewInSlice = slice.elements.some((e) => e.kind === "view");
    const hasCommandInSlice = slice.elements.some((e) => e.kind === "command");
    if (autoInSlice && !hasViewInSlice) continue;
    for (const ui of slice.elements.filter((e) => e.kind === "ui")) {
      if (hasViewInSlice || hasCommandInSlice) continue;
      const viewArrow = model.arrows.some((a) => {
        const from = a.fromId ? model.byId.get(a.fromId) : undefined;
        return a.toId === ui.id && from?.kind === "view";
      });
      const commandArrow = model.arrows.some((a) => {
        const to = a.toId ? model.byId.get(a.toId) : undefined;
        return a.fromId === ui.id && to?.kind === "command";
      });
      if (viewArrow || commandArrow) continue;
      pushDiag(diags, "both-ends-of-a-flow/ui-unbacked", {
        message:
          `ui "${ui.name}" has no read model backing it and issues no command; add a ` +
          `\`view\` it displays (event -> read model -> ui) or the command it triggers ` +
          `(ui -> command), or reconsider this screen`,
        line: ui.line,
        refs: [refOf(ui.id)],
      });
    }
  }

  // Every read model must be consumed. A view nothing displays or watches is the output-side
  // half-slice: information projected out of the system and then dropped on the floor. A
  // complete State View is event -> read model -> ui (or -> reaction, the Automation pattern).
  const consumedViews = new Set<string>();
  for (const el of model.elements) {
    // The renderer draws a reaction's `from` arrow to the nearest view instance at-or-before
    // it — that resolution is unchanged. But em's span-1/wire-once DSL rules force an
    // accumulating view across multiple slice instances, each re-declaring it with `from`
    // naming only the newly adjacent event, and the consuming reaction legitimately sits only
    // at the LAST instance. Crediting just that nearest instance (as before MIL-75) left every
    // earlier "fold" instance falsely warning "no consumer," even though it feeds the instance
    // the reaction reads. So for a reaction (AUTOMATION_KINDS), every instance at-or-before it
    // counts as consumed, not just the nearest one (MIL-75). Instances strictly after the last
    // consuming reaction still warn — they accumulate state nothing later reads — and a
    // logical view no reaction ever reads still warns on every instance.
    if (el.kind === "view") continue;
    for (const name of el.from ?? []) {
      const bucket = model.byName.get(normalizeName(name));
      if (!bucket) continue;
      const views = bucket.filter((x) => x.kind === "view");
      const atOrBefore = views
        .filter((x) => x.sliceIndex <= el.sliceIndex)
        .sort((a, b) => b.sliceIndex - a.sliceIndex);
      if (atOrBefore.length === 0) {
        // A reaction before any instance of the view (separately flagged by
        // reaction-from-future-view) — credit the first instance, same as pre-MIL-75 behavior.
        // There's no instance at-or-before to propagate backward from.
        if (views[0]) consumedViews.add(views[0].id);
      } else if (AUTOMATION_KINDS.has(el.kind)) {
        for (const v of atOrBefore) consumedViews.add(v.id);
      } else {
        consumedViews.add(atOrBefore[0].id);
      }
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
      // A `public` view is a published read API/webhook — its consumer is outside this
      // model, possibly outside this system entirely, so there's nothing local to point to.
      if (view.public) continue;
      pushDiag(diags, "both-ends-of-a-flow/view-unconsumed", {
        message:
          `read model "${view.name}" has no consumer; add the screen that displays it ` +
          `(a \`ui\` in this slice) or the reaction that watches it — or drop this instance`,
        line: view.line,
        refs: [refOf(view.id)],
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
    // A `public` event is part of the published integration surface — its reader is
    // outside this model, possibly outside this system entirely, so there's nothing local
    // to project it into.
    if (el.public) continue;
    pushDiag(diags, "both-ends-of-a-flow/event-unread", {
      message:
        `event "${el.name}" is not read by any read model; project it into a view ` +
        `(\`view X from "${el.name}"\`), or reconsider recording it`,
      line: el.line,
      refs: [refOf(el.id)],
    });
  }

  // Explicit arrow endpoints must resolve — and point forward.
  for (const a of model.arrows) {
    if (a.fromId && a.toId) {
      const fromEl = model.byId.get(a.fromId);
      const toEl = model.byId.get(a.toId);
      if (fromEl && toEl && toEl.sliceIndex < fromEl.sliceIndex) {
        pushDiag(diags, "arrow-backward", {
          message:
            `time flows left to right: arrow "${a.from}" -> "${a.to}" points backward ` +
            `(slice ${fromEl.sliceIndex + 1} -> ${toEl.sliceIndex + 1}); restructure so the target comes later`,
          line: a.line,
          refs: [refOf(fromEl.id), refOf(toEl.id)],
        });
      }
      // Inferred edges are legal by construction; a hand-written arrow is the one way an
      // illegal connection can enter a model, so check the kind pair against the patterns.
      if (fromEl && toEl && !isLegalFlow(fromEl.kind, toEl.kind)) {
        pushDiag(diags, "connection-legality/illegal-pair", {
          message:
            `arrow "${a.from}" -> "${a.to}" connects ${withArticle(fromEl.kind)} directly to ` +
            `${withArticle(toEl.kind)}: ${flowGuidance(fromEl.kind, toEl.kind)}`,
          line: a.line,
          refs: [refOf(fromEl.id), refOf(toEl.id)],
        });
      }
    }
    if (!a.fromId)
      pushDiag(diags, "arrow-unresolved-source", {
        message: `arrow source "${a.from}" does not match any element`,
        line: a.line,
        ...(a.toId ? { refs: [refOf(a.toId)] } : {}),
      });
    if (!a.toId)
      pushDiag(diags, "arrow-unresolved-target", {
        message: `arrow target "${a.to}" does not match any element`,
        line: a.line,
        ...(a.fromId ? { refs: [refOf(a.fromId)] } : {}),
      });
  }

  // Open issues (`issue "text"`) are always surfaced as a warning — the red-note
  // device for a question that hasn't been resolved yet.
  for (const el of model.elements) {
    if (el.issue) {
      pushDiag(diags, "open-issue", {
        message: `open issue on "${el.name}": ${el.issue}`,
        line: el.line,
        refs: [refOf(el.id)],
      });
    }
  }

  // `divergence "text"` deliberately raises NO diagnostic — unlike `issue`, it records a
  // deviation that's already been reasoned about and accepted, not an open question. The
  // entire point of the annotation is that it stops re-firing as a warning (or as conform-loop
  // drift) on every run; a warning here would defeat that. Use `em validate --list-divergences`
  // to audit them on demand instead.

  // Two translations sharing a name but reading from different producers is a naming
  // collision waiting to confuse a reader — the timeline shows the same name twice for two
  // unrelated external messages. Unlike the general ambiguous-name check below, this fires
  // unconditionally (not gated on `isReferenced`): a translation is itself a producer, not
  // typically something else's `from` target, so the confusion is in reading the model, not
  // in resolving a reference.
  const translationsByName = new Map<string, Element[]>();
  for (const el of model.elements) {
    if (el.kind !== "translation") continue;
    const key = normalizeName(el.name);
    const bucket = translationsByName.get(key);
    if (bucket) bucket.push(el);
    else translationsByName.set(key, [el]);
  }
  for (const group of translationsByName.values()) {
    if (group.length < 2) continue;
    const producerSets = group.map((t) => new Set((t.from ?? []).map(normalizeName)));
    const first = producerSets[0];
    const allSameProducers = producerSets.every(
      (s) => s.size === first.size && [...s].every((v) => first.has(v)),
    );
    if (allSameProducers) continue; // same producers, just repeated for clarity — not a collision
    pushDiag(diags, "translation-name-collision", {
      message:
        `translation "${group[0].name}" is defined ${group.length} times with different ` +
        `producers (${group.map((t) => `"${(t.from ?? []).join(", ") || "none"}"`).join(" vs ")}); ` +
        `use a distinct name per producer to avoid confusion`,
      line: group[0].line,
      refs: group.map((t) => refOf(t.id)),
    });
  }

  // Event tag metadata (MIL-66): identity (inline field `tag`), composite (`tag X from a, b`),
  // and external (`tag X external "..."`) tag keys. Only ever populated on events (`tag`
  // clauses are a parse error on any other kind), so no kind filter is needed to make either
  // loop below a no-op elsewhere.
  for (const el of model.elements) {
    // A composite tag's field list must name fields that actually exist on the event — checked
    // against `el.tags` directly (not the merged `collectTags` view) since only composite
    // clauses carry a field list to validate, and each needs its own `line` for the diagnostic.
    const fieldNames = new Set((el.fields ?? []).map((f) => normalizeName(f.name)));
    for (const t of el.tags ?? []) {
      if (t.kind !== "composite") continue;
      for (const fname of t.fields ?? []) {
        if (fieldNames.has(normalizeName(fname))) continue;
        pushDiag(diags, "tag-composite-unknown-field", {
          message:
            `event "${el.name}" tag "${t.key}" names field "${fname}", which isn't declared ` +
            `on this event`,
          line: t.line,
          refs: [refOf(el.id)],
        });
      }
    }

    // Duplicate tag key — inline identity keys and element-level (composite/external) keys
    // counted together, since they all share one namespace on the event.
    const tags = collectTags(el);
    if (tags.length === 0) continue;
    const keyCounts = new Map<string, { display: string; count: number }>();
    for (const t of tags) {
      const k = normalizeName(t.key);
      const entry = keyCounts.get(k);
      if (entry) entry.count++;
      else keyCounts.set(k, { display: t.key, count: 1 });
    }
    for (const { display, count } of keyCounts.values()) {
      if (count <= 1) continue;
      // Anchor to the offending clause's own line, like `tag-composite-unknown-field` does,
      // rather than the event's header line — look up the LAST element-level `tag` clause
      // (`el.tags`, which carries a `line`) whose key normalizes to this duplicate, falling
      // back to `el.line` when every occurrence is an inline field `tag` instead (fields carry
      // no line of their own).
      const normalizedKey = normalizeName(display);
      const lastClause = [...(el.tags ?? [])].reverse().find((t) => normalizeName(t.key) === normalizedKey);
      pushDiag(diags, "tag-duplicate-key", {
        message: `event "${el.name}" declares tag key "${display}" ${count} times; tag keys must be unique per event`,
        line: lastClause?.line ?? el.line,
        refs: [refOf(el.id)],
      });
    }
  }

  // Ambiguous names (used by arrows / view sources) get a heads-up.
  for (const [key, els] of model.byName) {
    // Later \`again\` instances of a view are the SAME logical read model reappearing on the
    // timeline — deliberate, not an ambiguity. Only warn when a duplicate is NOT an instance.
    const nonInstances = els.filter((e, i) => i === 0 || !(e.kind === "view" && e.again));
    if (nonInstances.length > 1 && isReferenced(model, key)) {
      pushDiag(diags, "duplicate-name", {
        message:
          `name "${els[0].name}" is defined ${nonInstances.length} times; ` +
          `references resolve to the first occurrence`,
        line: els[0].line,
        refs: nonInstances.map((e) => refOf(e.id)),
      });
    }
  }

  // Duplicate `type` names always warn, unconditionally — unlike the element check above,
  // there's no legitimate unreferenced-duplicate case for a named type: any field anywhere
  // that resolves that name is ambiguous about which declaration it means, whether or not
  // anything happens to reference it *today*.
  const typesByNormalizedName = new Map<string, TypeDecl[]>();
  for (const t of model.types) {
    const key = normalizeName(t.name);
    const bucket = typesByNormalizedName.get(key);
    if (bucket) bucket.push(t);
    else typesByNormalizedName.set(key, [t]);
  }
  for (const decls of typesByNormalizedName.values()) {
    if (decls.length > 1) {
      pushDiag(diags, "duplicate-type-name", {
        message: `type "${decls[0].name}" is defined ${decls.length} times; references resolve to the first occurrence`,
        line: decls[0].line,
        refs: decls.map((t) => refs.refByTypeId.get(t.id)!),
      });
    }
  }

  // Cyclic type references: recursion through declared types is allowed as a DAG (e.g. a
  // shared `Address` referenced twice is fine), but a cycle — a type transitively nesting
  // itself with no array to terminate it at runtime — can never be satisfied and is an error.
  for (const cycle of findTypeCycles(model)) {
    // cycle.path repeats its first name at the end (closing the loop) — dedupe by normalized
    // name before resolving to refs, so a 3-hop cycle reports 3 refs, not 4.
    const seen = new Set<string>();
    const cycleRefs: string[] = [];
    for (const name of cycle.path) {
      const key = normalizeName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const t = model.typesByName.get(key);
      if (t) cycleRefs.push(refs.refByTypeId.get(t.id)!);
    }
    pushDiag(diags, "type-cycle", {
      message: `type "${cycle.path[0]}" has a cyclic reference: ${cycle.path.join(" -> ")}`,
      line: cycle.line,
      refs: cycleRefs,
    });
  }

  return diags;
}

/**
 * DFS with 3-color marking (white/gray/black) over the type-reference graph: an edge A -> B
 * exists when A has a *bare* (non-array) field resolving to B. Array-typed self/mutual
 * references (`children: TreeNode[]`) are deliberately not graph edges — an array can
 * terminate at runtime (empty array), so it can express legitimate recursive/tree shapes
 * (categories, org charts, comment threads, BOMs); only an unconditional bare self-nesting is
 * structurally impossible and gets rejected. Returns one entry per cycle found, each already
 * a JS closed loop that will not be re-reported when reached again through another path
 * (DFS invariant: a node is colored black once fully explored and never re-explored).
 */
function findTypeCycles(model: NormalizedModel): { path: string[]; line: number }[] {
  const color = new Map<string, 0 | 1 | 2>(); // 0 = white, 1 = gray (on stack), 2 = black (done)
  const cycles: { path: string[]; line: number }[] = [];
  const stack: TypeDecl[] = [];

  const dependenciesOf = (t: TypeDecl): TypeDecl[] =>
    t.fields
      .map((f) => resolveTypeRef(f.type, model.typesByName))
      .filter((r): r is NonNullable<typeof r> => r !== null && !r.array)
      .map((r) => r.typeDecl);

  function visit(t: TypeDecl): void {
    color.set(t.id, 1);
    stack.push(t);
    for (const dep of dependenciesOf(t)) {
      const c = color.get(dep.id) ?? 0;
      if (c === 0) {
        visit(dep);
      } else if (c === 1) {
        const idx = stack.findIndex((s) => s.id === dep.id);
        cycles.push({
          path: [...stack.slice(idx).map((s) => s.name), dep.name],
          line: stack[idx].line,
        });
      }
      // c === 2 (black): already fully explored via another path — not a new cycle.
    }
    stack.pop();
    color.set(t.id, 2);
  }

  for (const t of model.types) {
    if ((color.get(t.id) ?? 0) === 0) visit(t);
  }
  return cycles;
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
    return "a reaction has to sit between them (read model -> processor -> command)";
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

/** JSON-shaped diagnostic — `line`/`refs` widened to explicit `null`/`[]`, same convention
 *  every other optional export field uses. Shared by `em export` (`emit/json.ts`) and `em
 *  diff --json` (`emit/diffJson.ts`, which spreads `{ side, ...serializeDiagnostic(d) }`) so
 *  the shape is defined once, next to the `Diagnostic` type it serializes. */
export function serializeDiagnostic(d: Diagnostic) {
  return { severity: d.severity, code: d.code, message: d.message, line: d.line ?? null, refs: d.refs ?? [] };
}

export type { Element };