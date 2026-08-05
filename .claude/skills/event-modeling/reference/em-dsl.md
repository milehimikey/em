<!-- DSL behavior change? Update BOTH docs/dsl.md and .claude/skills/event-modeling/reference/em-dsl.md -->

# `em` DSL Reference & Cheatsheet

The `em` tool (`@milehimikey/em`) is a slice-first text DSL rendered to a strict Graphviz
swimlane grid. Use this reference so the models you generate are **valid** and render cleanly.
Keep `.em` files focused on **structure**; put deep design in markdown linked via `note`.

---

## CLI

```bash
em init [file]                 # scaffold a starter model.em (default: model.em); -f to overwrite
em render <file> -o out.svg    # render (extension picks format: svg, png, pdf)
em render <file> --emit-dot    # print the Graphviz DOT instead of rendering
em render <file> --keep-empty-lanes   # keep the API lane even when empty
em watch  <file> -o out.svg    # re-render on every save (file-based)
em watch  <file> -o out.svg --serve   # + localhost live viewer, instant SSE push-reload (--port N)
em validate <file>             # check event-modeling rules; exit 0 if only warnings/clean
em validate <file> --list-issues       # print only open `issue "..."` clauses (slice, element, line, text)
em validate <file> --list-divergences  # print only `divergence "..."` clauses (slice, element, line, text)
em validate <file> --fail-on-issues    # opt-in CI gate: exit non-zero while any issue remains open
```

Install if missing: `npm i -g @milehimikey/em`. PNG works with no system deps; PDF needs
`rsvg-convert`.

---

## Grammar

```
model "Name"                     # diagram title

persona Name                     # a UI swimlane row (actor)
context Name                     # an event swimlane row (bounded context / aggregate)

slice "Name" {                   # one vertical time step (a column)
  ui   Free Text @Persona        # screen; @Persona picks its row (defaults to first/"User")
  command Free Text              # state-changing request (API band)
  view Free Text from "Event A", "Event B"   # read model fed by event(s)
  view Free Text again from "Event C"        # later instance of an evolving read model (see Clauses)
  event Free Text @Context       # recorded fact; @Context picks its row (defaults to "Domain")
  processor Free Text from "View"   # automation; aliases: automation | saga | translation
}

arrow From Element -> To Element    # explicit cross-slice edge (overrides inferred flow)
```

### Element kinds (8 keywords, nothing else)
| Keyword | Band | Meaning | Tag | Extra clauses |
|---|---|---|---|---|
| `ui` | persona | screen / interface | `@Persona` | `note`, `issue`, `divergence`, `{ fields }` |
| `command` | API | state-changing request | — | `note`, `issue`, `divergence`, `{ fields }` |
| `view` | API | read model / projection | — | `from "Event"…`, `note`, `issue`, `divergence`, `{ fields }` |
| `event` | context | recorded fact (past tense) | `@Context` | `note`, `issue`, `divergence`, `{ fields }` |
| `processor` / `automation` / `saga` / `translation` | automation | system reaction / adapter | — | `from "…"`, `note`, `issue`, `divergence`, `{ fields }` |

### Clauses
- **Tags:** `@Persona` only on `ui`; `@Context` only on `event`. Undeclared tags auto-create a row.
- **`from "X"`** on views/automations declares the source(s); names are quoted, comma-separated.
  Matching is case-insensitive and whitespace-normalized. A `from` may never point at an event or
  view that first appears in a LATER slice (forward-only timeline — validation error).
- **`again`** (views only): `view <Name> again [from "Event", …]` declares a later instance of an
  already-declared read model — the forward-only device for a view that evolves as later events
  land. Instances are ONE logical view: the first declaration owns the `note` binding; each
  instance's `from` lists only the NEW events landing at that point (not cumulative); a reaction
  (`from "View"`) reads the nearest instance at-or-before its own slice. Instances are NEVER
  connected to one another — continuity is implied by the shared name, and the events reaching each
  instance are what show the view changing. `again` with no earlier declaration is a validation error.
  Use `again` (not a plain repeated `view` name) whenever the view is referenced by a
  `from`/`arrow` — plain repeats are only warning-free while unreferenced.
- **`note "path.md"`** on ANY element links a markdown doc. Relative to the `.em` file. Renders as
  a clickable marker in SVG and a legend entry in PNG/PDF. **This is how slice docs attach.**
- **`issue "text"`** on ANY element flags an open question inline — the diagram-visible red
  sticky note. Renders as a red corner marker (opposite corner from `note`, so both can coexist
  on one element) plus a legend entry; `em validate` warns on every open issue. **Prefer this
  over a `# TBD` comment for anything that should show up on the rendered diagram** — `# TBD` is
  invisible once rendered, `issue` isn't.
- **`divergence "text"`** on ANY element records a reasoned, ratified deviation between this
  element and its implementation — the *resolved* sibling of `issue` (lint-suppression-with-
  rationale for the `conform` phase). Renders as a teal corner marker (bottom-right — distinct
  from `note`'s top-right and `issue`'s top-left, so all three can coexist) plus a legend entry.
  Raises **no** `em validate` warning by design; use `--list-divergences` to audit. `em diff
  --json` carries it forward as `acceptedDivergence` on the affected change/removal entry, so
  `conform` can cite an already-ratified deviation instead of re-flagging it as drift every run.
- **Fields:** `command Place Order { orderId: UUID, items: LineItem[], customerId }` — inline or
  one-per-line. Types are free text (no semantic checking). Keep these light; full field specs
  with rules live in the slice doc.
- **Comments:** `# ...` anywhere outside quotes (full-line or trailing).

### Swimlane band order (top → bottom)
Header row → **Automation** (only if used) → **persona** rows (in declared order) → **API**
(commands + views share this lane) → **context** rows (in declared order).

### Colors (for orientation)
UI = white, command = blue, event = amber/orange, view = green, automation = gray.

---

## Pattern → DSL mapping

```em
# 1. State Change: UI -> Command -> Event
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}

# 2. State View: Event(s) -> Read Model -> UI
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

# 3. Automation: split across TWO slices (plus the read slice that consumes the event)
slice "Orders To Fulfill" {
  view Orders To Fulfill from "Order Placed"
  processor Fulfillment Service
}
slice "Ship Order" {            # the triggered command goes in the NEXT slice
  command Ship Order
  event Order Shipped @Shipping
}
slice "Open Orders — shipped" {
  view Open Orders again from "Order Shipped"   # every event needs a reader
  ui Order List @Customer                       # ...and every read model needs a consumer
}

# 4a. Translation (external trigger): external input -> translation -> command -> event
slice "Carrier Webhook" {
  translation Carrier Adapter         # inbound from outside the model; no internal `from`
}
slice "Confirm Delivery" {            # the triggered command goes in the NEXT slice
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}
slice "Open Orders — delivered" {
  view Open Orders again from "Delivery Confirmed"
  ui Order List @Customer
}

# 4b. Translation (internal trigger): read model -> translation -> command -> event
slice "Accept Quote" {
  ui Quote Screen @Customer     # every command needs a trigger: a ui, or a reaction before it
  command Accept Quote
  event Quote Accepted @Quote
}
slice "Quotes To Sync" {
  view Accepted Quotes from "Quote Accepted"
  translation CRM Sync                # reacts to our own state via the read model in this slice
}
slice "Record Sync" {
  command Record Crm Sync
  event Quote Synced @Quote
}
slice "Accepted Quotes — synced" {
  view Accepted Quotes again from "Quote Synced"
  ui Sync Status @Customer
}
```

A `translation` (like a `processor`) is a **reaction**: it triggers a command and never carries an
`event` in its own slice. Same two-slice split as the Automation pattern above.

Note the read slice closing each pattern: **every event must be read by some read model**
(warning 4 below). A command slice is not finished until the slice that projects its event
exists. Reactions don't count — they read *views*, not events.

### Headless / API systems & repeated read models

A headless system (no screens — clients call an API) still uses `ui`/`persona`: a slice **is**
trigger → command → event, read vertically, so the trigger belongs *in* the slice, never split into
one of its own. Declare a persona per external caller/role and treat its `ui` boxes as API calls
instead of shipped screens — same two patterns (State Change, State View) as any other slice, no new
shape:

```em
persona IntegratorAPI   # API-flagged lane: its `ui` boxes are API calls, not shipped screens

slice "Create Quote" {
  ui Create Quote @IntegratorAPI
  command Create Quote
  event QuoteCreated @Quote
}

slice "Read Quote — created" {
  view Quote from "QuoteCreated"
  ui Read Quote @IntegratorAPI
}
```

- **`translation` stays reserved for genuine reactions and real external-system boundaries** — an
  internal automation, or a webhook/adapter crossing into another system (see the Automation and
  4a/4b Translation examples above, unchanged). It is **not** how you model a synchronous
  request/response API call — that's Pattern 1 (State Change) with an API persona, exactly like the
  `Create Quote` slice above.
- **Internal-only commands and views (no public route) carry no `ui` at all.** They follow the
  ordinary Automation pattern already documented: the reaction sits in the previous slice, and an
  internal-only read model is consumed by that reaction, not by a screen or an API query.
- **Repeat the read model** in every slice where it's read so the timeline flows left-to-right, and
  **prefer `view X again`** for every instance after the first (see Clauses) — **each instance
  carries its own consumer** (the `ui` that reads it, or a reaction), not just the last one. `again`
  instances are exempt from the duplicate-name warning even when referenced, and each reference
  resolves to the right instance — a plain repeat only stays warning-free while nothing references it by name, and
  resolves to the *first* declaration when something does. **Wire each event to a read model exactly
  once:** a repeated instance's `from` lists only the **new** events since the previous instance
  (not cumulative), or the event draws a duplicate arrow to the same read model at every repeat. (An
  event may still feed several *different* read models, once each.)
- **Instances are never joined to one another.** No arrow between two instances of one read model,
  ever — an explicit one is a validation error. The repeat is a timeline device: continuity is
  implied by the shared name, and the events arriving at each instance are what show it changing.
- **Keep arrows span-1: put each repeat right after its feeding event.** Place a read-model instance
  immediately after the event that updates it, sourcing only that single adjacent event. The
  renderer routes a long arrow *around* intervening boxes rather than through them, so it no longer
  reads as a forbidden read→read link — but distance is still a real problem: the arrowhead lands
  columns away from the event that produced it, so **the write slice reads as dangling**, as if
  nothing consumed its event. You have to trace a line across the diagram to see the connection.
  Keep the read model adjacent to its event, and keep a sub-flow that detours into another context
  together rather than parking it at the end of the model.

### Slice-ordering gotchas (edge inference)

`em` infers cross-slice arrows positionally, so **slice order matters**:
- A **reaction** (`processor`/`translation` that triggers a command) wires to the command in the
  **immediately next** slice. So a reaction slice must be *directly* followed by its command slice —
  don't insert a read slice between them.
- A read slice whose consumer is a **reaction** (`view` + `processor`/`translation`, no command in
  the same slice) must **not** be immediately followed by a `command` slice, or the reaction will be
  mis-wired to that command. Put it after a command+event slice, or before another read/reaction
  slice instead. (A `ui`-consumed read slice has no such risk — `ui` never wires as a reaction.)
- A read model fed by an early event (e.g. a queue or to-do view) can't always sit directly after
  its source event when a reaction must immediately precede its command slice — placing the read
  later, in narrative order with a longer arrow, is the correct trade-off, not something to force-fix.

---

## `em validate` rules (design to satisfy these)

**Errors (must fix):**
1. **Band collision** — two elements of the same band in one slice (e.g. two `command`s, or two
   `ui`s in the *same* persona row). Split them into separate slices/personas.
2. **Unknown event source** — `view X from "Event"` where the event doesn't exist anywhere.
3. **Unknown read-model source** — `processor X from "View"` where the view doesn't exist.
4. **Arrow endpoint mismatch** — `arrow A -> B` where A or B matches no element name.
5. **Backward timeline** ("time flows left to right") — an event feeding a view instance in an
   EARLIER slice (fix: add a `view X again` instance where the event lands and move the source
   there), a reaction reading a view before any instance of it exists, or an explicit backward
   `arrow`.
6. **`again` without an earlier declaration** — declare the view plainly the first time it appears.
7. **Illegal connection** — an `arrow` joining kinds the patterns don't connect. Only
   `ui -> command`, `command -> event`, `event -> view`, `view -> ui`, `view -> reaction`, and
   `reaction -> command` are allowed. A command straight to a view is the CQRS violation (an event
   has to sit between them); a view straight to a command needs a reaction between them; and two
   instances of one view are never connected at all. Inferred edges are always legal, so this only
   ever fires on a hand-written `arrow`.

**Warnings (should fix):**
1. **Automation/translation shares slice with its command** — both `automation`/`processor` and
   `translation` are reactions; put the triggered command in the *next* slice.
2. **Command with no trigger** — nothing issues it. A command needs a `ui` in its slice, or a
   reaction (automation/processor/saga/translation) in the slice *before* it. The input-side mirror
   of (4): a command nothing points at is a write nobody can start.
3. **Command without event** — every command should record at least one event.
4. **Event nobody reads** — the mirror of (3): recording an event no read model projects is a
   write with no reader. Follow every write slice with the read slice that consumes its event.
   Counts as read when a `view` names it in `from` (any `again` instance will do), when a
   fieldless-`from` view sits in its slice, or via an explicit `event -> view` arrow.
5. **Read model without source** — add `from "Event"` or place the view in a slice with an event.
6. **Duplicate name** — the same name defined N times; references resolve to the first. Rename.
7. **Open issue** — an element carries `issue "text"`; resolve the question, then remove the
   clause. `em validate --list-issues` prints just these; `--fail-on-issues` (opt-in) makes CI
   fail while any remain open.
8. **View field with no source** — a `view` field whose name matches no field on any instance
   of its source events. Only checked once BOTH the view and at least one source event declare
   `{ fields }`.
9. **Event field not from a command** — an `event` field whose name matches no field on any
   command in the same slice. Only checked once BOTH the event and at least one same-slice
   command declare `{ fields }`. This is the payoff of the fields feature for slicing rigor:
   once fields are written down, `em validate` checks that data flows forward consistently.

`divergence "text"` is deliberately NOT in this list — it raises no warning at all, since it
records a deviation already reasoned through and accepted, not something to fix. Use
`em validate --list-divergences` to audit them on demand.

**Design rules that keep models valid:**
- One element per band per slice (multiple personas/contexts are fine — they're different rows).
- Every `command` slice includes its `event`. Every `view` has a `from` source.
- **Every `command` has a trigger.** A `ui` in its slice, or a reaction in the slice *before* it.
  A command nothing points at is a write nobody can start.
- **Every `event` has a reader.** A command slice isn't finished until the read slice that projects
  its event exists. Reactions don't count — they read views, not events. Pair each write slice with
  its read slice as you go rather than sweeping up dangling events at the end.
- **Every `view` has a consumer.** A `ui` in its slice, a reaction watching it, or (headless) a read
  translation. Every *instance* of a repeat, not just the last — a bare `view X again` slice is a
  half-slice, not a State View.
- **Only six connections are legal**, and only these are ever inferred:
  `ui → command`, `command → event`, `event → view`, `view → ui`, `view → reaction`,
  `reaction → command`. Anything else in an explicit `arrow` is an error — above all
  `command → view` (the CQRS violation: an event has to sit between them) and `view → command`
  (a reaction has to sit between them). If you reach for an arrow the patterns don't allow, the
  model is missing an element, not an arrow.
- Automations **and translations** are always two slices: the reaction (plus its read model, if
  internally triggered) in one slice, the triggered `command` + its `event` in the next. A
  translation/automation slice **never contains an `event`** — reactions trigger commands, not
  events. Externally-triggered reactions start from outside the model (no `from`);
  internally-triggered ones read a **view** (read model) — `from "X"` must resolve to a view.
- Name everything uniquely and consistently.
- Events are past tense; commands are imperative; views name the thing shown.

> ⚠️ **Validator blind spot:** `em validate` does **not** flag a translation/automation that emits
> an event directly (e.g. `translation T` and `event E` in the same slice with no command). It only
> warns when a reaction shares a slice with a *command*. So enforce the two-slice
> `reaction → command → event` split **by construction** — never rely on `em validate` to catch a
> reaction wired straight to an event.
