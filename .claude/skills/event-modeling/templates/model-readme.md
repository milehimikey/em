# {{Model Name}}

{{One-paragraph description of the business process(es) this event model covers.}}

## Live view
While modeling, run the live view so the team can watch the diagram update:

```bash
em watch {{model-name}}.em -o {{model-name}}.svg   # re-renders on every save
# then open live.html in a browser (auto-refreshes ~1s; share the screen)
```

Static render: `em render {{model-name}}.em -o {{model-name}}.svg`

## Patterns legend
- **State Change** — UI → Command → Event
- **State View** — Event(s) → Read Model → UI
- **Automation** — Read Model → Processor → (next slice) Command → Event
- **Translation** — External input (or Read Model) → Translation → (next slice) Command → Event

## Slices
<!-- Keep this index in sync as slice docs are written. -->
| # | Slice | Pattern | Design doc |
|---|-------|---------|------------|
| 1 | {{Slice Name}} | {{Pattern}} | [slices/{{slice-name}}.md](slices/{{slice-name}}.md) |

## Status
See [`.event-modeling.md`](.event-modeling.md) for current phase, decisions, and open questions.
