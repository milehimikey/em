# Validation rules

`em validate` checks a model against the rules of Event Modeling. Errors block rendering
(`em render` refuses, `em watch` skips the save); warnings print but don't. The same checks
run on every command that reads a model.

## Errors

| Rule | Fix |
|---|---|
| Two elements of the same band in one slice (a collision — e.g. two commands, or two `ui`s in the same persona row) | Split them into separate slices |
| `view X from "Event"` where no such event exists | Fix the name, or add the missing event |
| An event feeding a view instance that sits earlier on the timeline | Add `view X again` at the point where the event lands, and move the source there (see [timeline.md](timeline.md)) |
| A reaction's `from "View"` where no such read model exists | Fix the name, or add the missing view |
| A reaction reading a view before any instance of it exists | Declare the view in or before the reaction's slice |
| `view X again` with no earlier declaration of `X` | Declare the view plainly the first time it appears |
| An `arrow` endpoint that matches no element | Fix the name |
| An `arrow` that points backward in time | Restructure so the target comes later |
| An `arrow` between element kinds the four patterns don't connect | Add the missing step — the message names it |

The timeline rules ("time flows left to right") are the Two Laws in action;
[timeline.md](timeline.md) explains them with examples.

### Connection legality

em infers a slice's arrows from its shape, and only ever infers legal ones, so a
hand-written `arrow` is the single way an illegal connection can get into a model. Those are
checked against the [four patterns](patterns.md): the only pairs allowed are
`ui → command`, `command → event`, `event → read model`, `read model → ui`,
`read model → reaction`, and `reaction → command`.

Everything else is an error, reported with the step that's missing:

```
error:38 arrow "Open Ticket" -> "Ticket Queue" connects a command directly to a read
         model: an event has to sit between them (command -> event -> read model)
```

That one is the CQRS violation — a write is only ever visible to a reader through the event
it recorded. The same check catches `read model → command` (a reaction belongs between
them), `event → command`, `event → event` (Law 1), and an arrow between two instances of one
read model (see [timeline.md](timeline.md)).
[examples/timeline-rules-invalid.em](../examples/timeline-rules-invalid.em) collects one of
each; run `em validate` on it to see all five.

## Warnings

| Rule | Fix |
|---|---|
| A `processor`/`translation` shares a slice with a command | Reactions trigger commands; put the triggered command in the next slice |
| A command that records no event | Add the event, or reconsider the command |
| An event no read model reads | Project it into a view, or reconsider recording it |
| A read model with no source | Add `from "Event"`, or place it in a slice with an event |
| A name defined more than once and referenced by a `from` or `arrow` | Rename; references resolve to the first occurrence |
| An element carries an open `issue "text"` | Resolve the question, then remove the clause |
| A `view` field with no matching field on any source event | Add the field to the event, or drop it from the view |
| An `event` field not provided by any command in its slice | Add the field to the command, or drop it from the event |

Rendering also warns (without failing) when a `note "path.md"` points at a file that
doesn't exist.

### Both ends of a flow

Two warnings guard the ends of the State Change → State View chain, and they mirror each
other: **a command that records no event** is a write that changes nothing, and **an event no
read model reads** is a write nobody can see. There is no point recording an event if nothing
projects it, so a command whose event dangles is an unfinished slice — the read slice hasn't
been written yet.

An event counts as read when a `view` names it in `from`, when a `view` with no `from` sits in
its slice, or when an explicit `arrow` points from it to a read model. Any instance of a
repeated read model counts, so `view X again from "Event"` satisfies it.

Both are warnings rather than errors on purpose. A model under construction spends most of its
life with a write slice ahead of its read slice, and errors block rendering — `em watch` would
stop redrawing mid-session exactly when you most want to see the diagram.

### Fields completeness

This is the payoff of the `{ fields }` block for slicing rigor: once you bother writing down
what data an element actually carries, `em validate` can check that data flows forward
consistently instead of trusting it by eye.

- **View ← events** — every field on a `view` should trace back to a field on one of its
  source events (any instance of each named event, unioned). A view field with no matching
  event field gets a warning.
- **Event ← command** — every field on an `event` should trace back to a field on a command
  in the same slice (unioned across commands, in the rare case a slice has more than one).
  An event field the command never mentions gets a warning.

Both checks only fire when **both sides declare `{ fields }`** — the view/event being
checked, and *every* element on the contributing side (every source event of the view;
every command in the slice). A model that never uses fields produces zero completeness
warnings, a view/event that hasn't gotten a fields block yet is silently skipped rather
than flagged, and a mixed contributing side (say, `from "A", "B"` where only `A` declares
fields) is also skipped — a fieldless `B` may well be the field's provider, so a warning
there could flag a legitimate field. Field names are matched with the same
normalization as `from`/`arrow` references (trim, lowercase, collapse whitespace); types are
not compared. UI fields, cross-slice/automation tracing, and rename detection are out of
scope for now.

**Expect some of these warnings to be correct and permanent.** System-generated data —
identifiers the server mints, `…At` timestamps taken at decision time, values a read model
derives rather than copies — legitimately appears on an event or view without appearing on
the command that triggered it. The example model shipped with `em` warns for exactly this
reason. The rule can't tell "the system supplies this" from "somebody forgot this", so it
reports both and leaves the judgment to you: confirm it's intentional and move on, or add
the field where it was genuinely missing. That's also why these are warnings and never
block a render or a merge.

An `issue` warning never blocks by default, same as every other warning — `em render`,
`em watch`, and `em validate` all still succeed on a model with open issues. Use
`em validate --list-issues` to print just the open issues (slice, element, line, text), and
`em validate --fail-on-issues` (opt-in) to make CI fail while any remain — see
[cli.md](cli.md).

## What the validator can't catch

Connection legality is checked on `arrow` statements, which is where an illegal connection
can be written down. It can't be checked on slice *shape*, because shape is what em reads to
infer arrows in the first place: a `translation` or `processor` sharing a slice with an
`event` but no `command` is a reaction wired straight to an event, and nothing flags it. em
only warns when a reaction shares a slice with a command. Reactions must always go through a
command (`reaction → command → event`, split across two slices); enforce that by
construction. The [patterns](patterns.md) doc covers why.
