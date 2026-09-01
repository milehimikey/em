# Operating principles, preconditions, and project layout (every phase)

Shared by every `event-modeling-*` skill. Read this before doing any work in any phase — it's
the discipline and mechanics that don't change no matter which phase you're facilitating.
`methodology.md` (the 7 steps + 4 patterns) and `em-dsl.md` (DSL syntax and validation rules) in
this same directory are the other two shared references; read them too before doing real work —
they, together with this doc, are the source of truth every phase skill builds on. Templates
live in `templates/`, a sibling of this `reference/` directory. References to `docs/*.md`
throughout these skills mean the
[em repository's docs](https://github.com/milehimikey/em/tree/main/docs) — they are not
vendored alongside these skills, with one exception: the frontmatter schema doc is vendored
right here as `reference/slice-doc-schema.md` (kept in sync with the em repo's
`docs/slice-doc-schema.md` by `em`'s own `docs:generate`/`docs:check`), so every
`slice-doc-schema.md` reference elsewhere in this bundle points there instead of at `docs/`.

## Operating principles

- **Socratic, one question at a time.** Ask focused questions; use `AskUserQuestion` for tight
  multiple-choice decisions. Never assume a domain fact — extract it. Prefer "who/why/what-if/
  what-must-always-be-true/how-do-you-know" over yes-no.
- **Don't guess — park it.** Unresolved items go into the Open Questions list in
  `.event-modeling.md`, not into invented model content. Note the source, blocker, and revisit
  date when known — cheap now, useful when you come back to it.
- **Happy path first; branches belong to slicing.** Steps 1-7 build the **happy-path spine**.
  Alternate, unhappy, and exception-path events (rejections, removals, cancellations,
  expirations, declines) are **not** enumerated as a separate discover/model task — they
  surface during the `slice` phase as each slice's alternate/error flows and rule-boundary
  scenarios, and any new branch events get added to the `.em` then. Never list "draft the
  branch events" as a discover/model to-do or ask the user to do it before slicing.
- **Reflect and re-render.** After each meaningful increment, update the `.em` file, re-render,
  and show the user what changed. Encourage running the live view (`watch`) so a team can follow.
- **Keep the `.em` structural; put depth in `note` docs.** The diagram holds flow; invariants,
  fields, and scenarios live in `slices/*.md` linked via `note "slices/<name>.md"`.
- **Headless/API models still use `ui`.** If the system is headless (clients call an API, not
  screens), declare a persona per external caller/role (e.g. `IntegratorAPI`) and treat its `ui`
  boxes as API calls, not screens: writes are `ui → command → event` and reads are
  `read model → ui`, exactly like any other State Change/State View slice — no separate trigger
  slice. `translation` stays reserved for genuine reactions and real external-system boundaries,
  not a synchronous request/response call. Internal-only commands/views with no public route carry
  no `ui` at all — they follow the ordinary Automation pattern instead. **Repeat read models**
  across slices so the timeline flows left-to-right — put each repeat **right after the event that feeds it**, sourcing
  only that one adjacent event, so every arrow is short (a read model far from its source events
  draws a long arrow whose head lands columns away, making the *write* slice read as dangling —
  keep a sub-flow that detours into another context together, not parked at the end of the model).
  Declare every instance after the first with
  **`view X again from "..."`** — `again` instances are exempt from the duplicate-name warning even
  when referenced, and each reference resolves to the right instance. A reaction's command is
  wired by same-slice presence, exactly like `ui → command` — no positional/adjacency rule to get
  right (see `em-dsl.md`).
  See `methodology.md` (State View) and `em-dsl.md`.
- **Never connect two instances of one read model.** The repeat is a timeline device, not a flow:
  continuity is implied by the shared name, and the events arriving at each instance are what show
  it changing. An arrow between instances says the read model feeds itself, and is an error.
- **Every slice is a COMPLETE pattern, never a half-slice.** A State Change is
  `ui → command → event`; a State View is `event → read model → ui` (or `→ reaction`). So: a
  command needs something that **triggers** it (the `ui` it's issued from, or the reaction that
  triggers it, also in this slice), its event needs a **reader**, and that read model needs a
  **consumer** of its own. A command nothing points at is a write nobody can start; a reaction
  that triggers no command is a decision the system never acts on; an event nothing projects is
  a write nobody can see; a read model nothing displays is information dropped on the floor.
  Write the whole chain together rather than sweeping up dangling ends later. Reactions don't
  count as readers of *events* — they read views. **Every instance** of a repeated read model
  needs its own consumer: if you repeat a view next to an event just to keep the arrow short,
  bring its screen along, or don't add the instance.
- **Only six connections are legal:** `ui → command`, `command → event`, `event → read model`,
  `read model → ui`, `read model → reaction`, `reaction → command`. Reaching for anything else —
  above all `command → read model` (the CQRS violation) or `read model → command` — means the model
  is missing an **element**, not an arrow.
- **Validate continuously.** Run `em validate` and fix errors/warnings as you go (see DSL ref).
- **Save state at the end of every session** so work resumes cleanly. Also log a Usage log
  line: `em state log-usage <model>.em --phases <phase1,phase2,...>` computes and dedupes the
  diagnostic *categories* that fired for you and appends the canonically-formatted line — never
  hand-run `em validate --json` and format the line yourself. This is the team's only usage
  signal today (`docs/usage-data.md`) — keep it cheap and habitual, not a task to skip.

## Preconditions (run first)

1. Check the tool: `em --version`. If missing, tell the user to run `npm i -g @milehimikey/em`
   and stop until installed.
2. Locate the model. Look for an existing `<dir>/.event-modeling.md` and `*.em` in the working
   directory, or — for a multi-model project laid out per the convention below — one level down
   inside a `models/` subfolder (each model gets its own `models/<slug>/` directory; check each
   candidate for its own `.event-modeling.md`/`*.em` pair). If found, run `em state read <dir>`
   to read the state file's mechanical fields (model path, phase, step, last updated, last
   conformance, last review) as JSON — don't parse the bullets by hand. If not, and the phase
   needs one, ask the user for the model name and where to create it (a lone model goes at the
   project root; one of several goes under `models/`, per "Multi-model projects" below).
3. If you're not sure which phase applies, or the user gave no phase, use `em state read <dir>`'s
   `phase`/`step` to resume the recorded phase/step — or invoke the `event-modeling` skill, which
   does exactly this and routes to the right skill. If no model exists, propose starting
   `discover` (greenfield, `event-modeling-discover`) or `extract` (modeling an existing system,
   also `event-modeling-discover`).
4. Populate the state file's Participants section at session start. For a live workshop, ask for
   a single human proxy to relay questions to the room, and attribute every answer/decision in
   the Decisions log to a named participant.

## Project layout these skills create

```
<model-name>/
  <model-name>.em          # the model (slice docs linked via note "...")
  <model-name>.svg         # render target for em watch
  README.md                # overview + slice index (from templates/model-readme.md)
  .event-modeling.md       # resumable state (from templates/state.md)
  slices/<slice-name>.md   # one rich slice doc per slice (from templates/slice.md)
  conformance/<date>-report.md
                           # conform-phase reports (from templates/conformance-report.md)
  <model-name>-asis.em     # conform-phase scratch model, regenerated per run — git-ignore this
```

When creating a new model, run `em scaffold <model-name>` — it creates `<model-name>/` and
writes all three starter files in one step (`<model-name>.em`, `README.md`,
`.event-modeling.md`), filling the Model Name/model-name placeholders and the state file's
mechanical fields (model path, `Current phase: discover`, `Current step: 1`, dates) for you, so
there's nothing left to hand-copy or fill in. Refuses if `<model-name>/` already exists; pass
`--force` to overwrite. You'll
usually replace the scaffolded `.em`'s content as the discovery conversation builds up the real
model — it starts out as the same starter model `em init` writes, titled from `<model-name>`.
`slices/*.md` and `conformance/` aren't part of `em scaffold`; they come from the `slice` and
`conform` phases (`event-modeling-design` and `event-modeling-conform`). The `conformance/`
directory and `<model-name>-asis.em` only appear once the `conform` phase runs; `em conform-scope
--seed-asis` creates `<model-name>-asis.em` and gitignores `*-asis.em` for you (see
`event-modeling-conform`'s `reference/conform.md`) — it's scratch, never committed.

### Multi-model projects

Slice docs resolve at a fixed path — `slices/<slug>.md`, sibling of the `.em` file that
declares the slice — with no model namespace anywhere, so **one directory per model** is the
whole guardrail against two models' slice names colliding. For more than one model, nest each
one's directory (the exact layout above) under a shared `models/` parent instead of scattering
them at the project root:

```
models/
  checkout/
    checkout.em
    slices/...
  fulfillment/
    fulfillment.em
    slices/...
```

Run `em scaffold <model-name> --under models` for each model — it creates `models/<slug>/`
directly rather than a two-step `cd models && em scaffold <model-name>`. See
[docs/cli.md, "Multi-model projects"](https://github.com/milehimikey/em/blob/main/docs/cli.md#multi-model-projects)
for the full rationale, and why slice keys stay unqualified (no `<model>/<slice>` prefix) —
directory isolation alone is sufficient. Two `.em` files sharing a directory with colliding
slice keys don't go undetected: `em status`/`em catalog`, the two commands that ever compile
more than one model in a run, raise a `cross-model-slice-doc-collision` warning naming both
files — treat that warning as a sign the models need separating, not a false positive.
