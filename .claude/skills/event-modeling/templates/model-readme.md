# {{Model Name}}

{{One-paragraph description of the business process(es) this event model covers.}}

## Live view
While modeling, run the live view so the team can watch the diagram update:

```bash
em watch {{model-name}}.em -o {{model-name}}.svg --serve   # re-render + instant push-reload
# then open the URL it prints (http://localhost:5173/?svg={{model-name}}.svg) and share the screen
```

No server? Run `em watch {{model-name}}.em -o {{model-name}}.svg` and open
`live.html?svg={{model-name}}.svg` in a browser (polls ~2s; share the screen).

Static render: `em render {{model-name}}.em -o {{model-name}}.svg`

## Patterns legend
- **State Change** — UI → Command → Event
- **State View** — Event(s) → Read Model → UI
- **Automation** — Read Model → Processor → (next slice) Command → Event
- **Translation** — External input (or Read Model) → Translation → (next slice) Command → Event

Between them these are the only legal connections: `ui → command`, `command → event`,
`event → read model`, `read model → ui`, `read model → reaction`, `reaction → command`. A command
never reaches a read model directly — the event goes between them. Every slice is joined up at
both ends: something triggers each command (the screen it's issued from, or the reaction in the
slice before it), and every event a command records is read by some read model — so each State
Change slice is paired with the State View slice that projects its event. A read model repeated
along the timeline (`view X again`) shows the same projection at a later point; the instances are
never connected to one another.

## Slices
<!-- The canonical slice index — the ONE place slices are enumerated (the state file
     points here rather than keeping its own copy). Keep it in sync as slice docs are
     written and as statuses move. -->
| # | Slice | Pattern | Status | Design doc |
|---|-------|---------|--------|------------|
| 1 | {{Slice Name}} | {{Pattern}} | {{none / draft / reviewed / ready-to-implement / implemented}} | [slices/{{slice-name}}.md](slices/{{slice-name}}.md) |

## Status
See [`.event-modeling.md`](.event-modeling.md) for current phase, decisions, and open questions.
