---
name: event-modeling
em-version: 1.9.1
description: >-
  Use when the user runs `/event-modeling` (with or without a phase name), or wants to resume an
  event-modeling session without specifying which part of the process applies. Reads the model's
  `.event-modeling.md` state (or the given phase name) and routes to the right focused skill —
  event-modeling-discover, event-modeling-design, event-modeling-implement, event-modeling-conform,
  or event-modeling-review. If you already know which of those applies — starting a new model,
  extracting from existing code, slicing/writing specs, implementing a ratified slice, checking
  drift, or running a live/stakeholder view — invoke that skill directly instead of this one.
---

# Event Modeling with `em` — resume / route

`em` drives Event Modeling through nine phases — `discover, extract, model, slice, implement,
conform, watch, review, validate` — split across five focused skills, one per stage of the
process. This router skill is the single entry point for `/event-modeling`: it figures out which
phase applies and hands off, so you never need to remember which of the five skills a given
phase lives in.

| These phases... | ...live in this skill |
|---|---|
| `discover`, `extract` | `event-modeling-discover` — starting a new model, or extracting a current-state model from an existing codebase |
| `model`, `slice` | `event-modeling-design` — structuring the model into swimlanes/patterns, writing deep slice specs |
| `implement` | `event-modeling-implement` — building one ratified slice into merged, tested code |
| `conform`, `validate` | `event-modeling-conform` — drift-checking a model against its codebase, walking validation diagnostics |
| `watch`, `review` | `event-modeling-review` — the live browser viewer, facilitated stakeholder walkthroughs |

## Routing logic

1. Check the tool: `em --version`. If missing, tell the user to run `npm i -g @milehimikey/em`
   and stop until installed.
2. Parse `$ARGUMENTS` for a phase name.
   - **A recognized phase name** (`discover`, `extract`, `model`, `slice`, `implement`,
     `conform`, `validate`, `watch`, `review`): look it up in the table above and invoke that
     skill directly (via the `Skill` tool), passing the phase name along so it knows exactly
     where to start. Don't re-derive state first — the target skill's own preconditions handle
     that.
   - **No argument:** locate the model (an `.event-modeling.md`/`*.em` pair in the working
     directory, or one level down under `models/<slug>/` for a multi-model project — see
     `../event-modeling-shared/reference/operating-principles.md`). If found, run
     `em state read <dir>` and read its `phase` field as JSON — don't parse the state file's
     bullets by hand. Map that phase through the table above and invoke the matching skill,
     telling it to resume at the recorded `step` too. If no model exists yet, ask the user
     whether this is a new model (`event-modeling-discover`, `discover`) or an existing system to
     extract from (`event-modeling-discover`, `extract`), then invoke that skill.
   - **An unrecognized argument:** treat it as free-text intent and pick the best-matching skill
     from the table's description, same as you would if the user had asked in plain language.
3. Once you've handed off, this skill's job is done for the session — the target skill owns the
   conversation from there, including re-invoking `event-modeling` (this skill) itself at the end
   if the user wants to stop and resume later.

## Shared reference material

Every phase skill (and this one) points back to the same shared resources rather than
duplicating them — read them once, they apply everywhere:

- `../event-modeling-shared/reference/operating-principles.md` — the Socratic/validation discipline
  every phase follows, the preconditions above in full, and the project layout these skills
  create (including multi-model projects).
- `../event-modeling-shared/reference/methodology.md` — the 7 steps and 4 patterns (Event Modeling
  methodology).
- `../event-modeling-shared/reference/em-dsl.md` — `em`'s DSL grammar, CLI reference, and the full
  `em validate` rule catalog.
- `../event-modeling-shared/templates/*.md` — the slice/state/model-readme/conformance-report
  templates every phase scaffolds from.

## em command reference (quick)

<!-- GENERATED:cli-quick:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
```bash
em --version
em init <name>.em                          # optional starter scaffold
em scaffold <name>                         # full project: <slug>/<slug>.em, README.md, .event-modeling.md
em validate <name>.em                      # check rules; exit 0 if clean/warnings only
em render <name>.em -o <name>.svg          # render (svg/png/pdf by extension)
em render <name>.em --emit-dot             # inspect generated Graphviz DOT
em render <name>.em --slice "<slice-name>" -o slices/<slug>.svg   # this slice's own diagram
em watch <name>.em -o <name>.svg           # re-render on save (run in background)
em watch <name>.em -o <name>.svg --serve   # + the live browser viewer: instant push-reload, pan/zoom (--port N)
                                            #   click "Review mode" for a slice-by-slice storyboard walkthrough
```
<!-- GENERATED:cli-quick:end -->

Always finish a working session by: re-rendering, running `em validate`, and updating
`.event-modeling.md` — `em state set-phase <phase> [--step <n>]` for the current phase/step,
decisions and open questions by hand, and `em state log-usage <model>.em --phases <phases>` for
the Usage log entry.
