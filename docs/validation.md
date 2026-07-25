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

The timeline rules ("time flows left to right") are the Two Laws in action;
[timeline.md](timeline.md) explains them with examples.

## Warnings

| Rule | Fix |
|---|---|
| A `processor`/`translation` shares a slice with a command | Reactions trigger commands; put the triggered command in the next slice |
| A command that records no event | Add the event, or reconsider the command |
| A read model with no source | Add `from "Event"`, or place it in a slice with an event |
| A name defined more than once and referenced by a `from` or `arrow` | Rename; references resolve to the first occurrence |
| An element carries an open `issue "text"` | Resolve the question, then remove the clause |
| A `view` field with no matching field on any source event | Add the field to the event, or drop it from the view |
| An `event` field not provided by any command in its slice | Add the field to the command, or drop it from the event |

Rendering also warns (without failing) when a `note "path.md"` points at a file that
doesn't exist.

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

Both checks only fire when **both sides declare `{ fields }`** — a model that never uses
fields produces zero completeness warnings, and a view/event that hasn't gotten a fields
block yet is silently skipped rather than flagged. Field names are matched with the same
normalization as `from`/`arrow` references (trim, lowercase, collapse whitespace); types are
not compared. UI fields, cross-slice/automation tracing, and rename detection are out of
scope for now.

An `issue` warning never blocks by default, same as every other warning — `em render`,
`em watch`, and `em validate` all still succeed on a model with open issues. Use
`em validate --list-issues` to print just the open issues (slice, element, line, text), and
`em validate --fail-on-issues` (opt-in) to make CI fail while any remain — see
[cli.md](cli.md).

## What the validator can't catch

`em validate` does not flag a reaction wired straight to an event — a `translation` or
`processor` sharing a slice with an `event` but no `command`. It only warns when a reaction
shares a slice with a command. Reactions must always go through a command
(`reaction → command → event`, split across two slices); enforce that by construction. The
[patterns](patterns.md) doc covers why.
