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

Rendering also warns (without failing) when a `note "path.md"` points at a file that
doesn't exist.

## What the validator can't catch

`em validate` does not flag a reaction wired straight to an event — a `translation` or
`processor` sharing a slice with an `event` but no `command`. It only warns when a reaction
shares a slice with a command. Reactions must always go through a command
(`reaction → command → event`, split across two slices); enforce that by construction. The
[patterns](patterns.md) doc covers why.
