<!-- DSL behavior change? Update BOTH docs/dsl.md and .claude/skills/event-modeling/reference/em-dsl.md -->

# `em` DSL Reference & Cheatsheet

The `em` tool (`@milehimikey/em`) is a slice-first text DSL rendered to a strict Graphviz
swimlane grid. Use this reference so the models you generate are **valid** and render cleanly.
Keep `.em` files focused on **structure**; put deep design in markdown linked via `note`.

---

## CLI

<!-- GENERATED:cli:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
```bash
em --version                              # print the installed em version
em init [file]                            # scaffold a starter .em model
em init [file] -f, --force                # overwrite if the file exists
em render <file>                          # transpile a model and render it (or emit DOT)
em render <file> -o, --out <path>         # output path (extension picks the format)
em render <file> -T, --format <fmt>       # output format (svg, png, pdf, ...)
em render <file> --slice <name>           # render only this slice, redrawn in its own canonical pattern shape (default out: slices/<kebab-slug>.svg)
em render <file> --emit-dot               # print the generated DOT instead of rendering
em render <file> --keep-empty-lanes       # keep the API lane even when empty
em export <file>                          # export a versioned JSON snapshot of the normalized model
em export <file> -o, --out <path>         # write to a file instead of stdout
em diff <old> [new]                       # compare two models structurally (two files, or one file across git revisions)
em diff <old> [new] --from <rev>          # diff <old> against this git revision instead of a second file
em diff <old> [new] --to <rev>            # diff against this git revision instead of the current file (requires --from)
em diff <old> [new] --exit-code           # exit 1 if the models differ, 0 if identical (git-diff convention)
em diff <old> [new] --json                # print a JSON document instead of the text report (see docs/cli.md)
em glossary <files>                       # cross-model glossary of terms, with consistency checks across models (see docs/cli.md)
em glossary <files> --json                # print the full glossary document instead of the text report
em glossary <files> -o, --out <path>      # write the JSON document to a file instead of stdout (requires --json)
em glossary <files> --list-conflicts      # print only the conflict lines, no summary
em glossary <files> --fail-on-conflicts   # exit non-zero if any cross-model term conflicts were found (opt-in — conflicts are warnings and don't block by default)
em catalog <files>                        # generate a browsable static HTML catalog site over one or more .em models (see docs/cli.md)
em catalog <files> -o, --out <dir>        # output directory
em catalog <files> -T, --format <fmt>     # diagram format embedded in the catalog (svg or png)
em catalog <files> --title <text>         # catalog site title
em catalog <files> --keep-empty-lanes     # keep the API lane even when empty
em changelog <file>                       # render a model's git history as a business-readable ledger (see docs/cli.md)
em changelog <file> --from <rev>          # start the walk at this revision (inclusive)
em changelog <file> --to <rev>            # end the walk at this revision (inclusive; default HEAD)
em changelog <file> -o, --out <path>      # write to a file instead of stdout
em watch <file>                           # re-render on every save
em watch <file> -o, --out <path>          # output path (extension picks the format)
em watch <file> -T, --format <fmt>        # output format (svg, png, pdf, ...)
em watch <file> --keep-empty-lanes        # keep the API lane even when empty
em watch <file> --serve                   # serve a live viewer with instant push-reload (no polling)
em watch <file> --port <n>                # port for --serve (default 5173)
em validate <file>                        # check a model against event-modeling rules
em validate <file> --list-issues          # print only open `issue` diagnostics (slice, element, line, text)
em validate <file> --list-divergences     # print only accepted-divergence annotations (slice, element, line, text) — never fails the build
em validate <file> --list-public          # print only events marked `public` (slice, name, line) — an integration-surface audit, never fails the build
em validate <file> --fail-on-issues       # exit non-zero if the model has any open `issue`s (opt-in — issues are warnings and don't block by default)
em validate <file> --slice-ready <key>    # readiness gate for one slice (export key): status ready-to-implement, doc resolvable via note binding, zero unchecked Open Questions — exits non-zero if not ready (MIL-87)
em ledger <file>                          # check slice docs' version: field agrees with their content across two git revisions (opt-in CI check, MIL-89 — never part of `em validate`, see docs/ci.md)
em ledger <file> --from <rev>             # baseline revision
em ledger <file> --to <rev>               # compare revision (default: current working tree)
em ledger <file> --json                   # print a JSON document instead of the text report (see docs/cli.md)
em skill install                          # copy the event-modeling skill into .claude/skills/event-modeling/
em skill install -f, --force              # overwrite an existing installation
```
<!-- GENERATED:cli:end -->

Install if missing: `npm i -g @milehimikey/em`. PNG works with no system deps; PDF needs
`rsvg-convert`.

---

## Grammar

```
model "Name"                     # diagram title

persona Name                     # a UI swimlane row (actor)
context Name                     # an event swimlane row (bounded context / aggregate)

slice "Name" [source "url"] {    # one vertical time step (a column); source is optional
  ui   Free Text @Persona        # screen; @Persona picks its row (defaults to first/"User")
  command Free Text              # state-changing request (API band)
  view Free Text from "Event A", "Event B"   # read model fed by event(s)
  view Free Text again from "Event C"        # later instance of an evolving read model (see Clauses)
  event Free Text @Context       # recorded fact; @Context picks its row (defaults to "Domain")
  processor Free Text from "View"   # automation; aliases: automation | saga | translation
}

arrow From Element -> To Element    # explicit cross-slice edge (overrides inferred flow)

type Name { field: Type, ... }      # named structured type, reusable from any field (see Named types)
```

### Element kinds (8 keywords, nothing else)
| Keyword | Band | Meaning | Tag | Extra clauses |
|---|---|---|---|---|
| `ui` | persona | screen / interface | `@Persona` | `note`, `issue`, `divergence`, `{ fields }` |
| `command` | API | state-changing request | — | `note`, `issue`, `divergence`, `{ fields }` |
| `view` | API | read model / projection | — | `from "Event"…`, `note`, `issue`, `divergence`, `{ fields }` |
| `event` | context | recorded fact (past tense) | `@Context` | `note`, `issue`, `divergence`, `public`, `{ fields }` |
| `processor` / `automation` / `saga` / `translation` | automation | system reaction / adapter | — | `from "…"`, `note`, `issue`, `divergence`, `{ fields }` |

### Clauses
- **Tags:** `@Persona` only on `ui`; `@Context` only on `event`. Undeclared tags auto-create a row.
- **`from "X"`** on views/automations declares the source(s); names are quoted, comma-separated.
  Matching is case-insensitive and whitespace-normalized. A `from` may never point at an event or
  view that first appears in a LATER slice (forward-only timeline — validation error).
  Kinds never cross: a view's `from` resolves ONLY to events; a reaction's `from` resolves ONLY
  to read models — naming an event on a reaction is a validation error even though the event
  exists. Feed an event to a reaction by projecting it into a view first (the automation's
  "to-do list") and pointing the reaction at that view. Name that view after the pending work
  (`Payments To Process`), never after the triggering event — a view reusing the event's name
  collides in the shared namespace and draws a duplicate-name warning.
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
- **`public`** (events only): marks this event as part of the published integration surface
  (e.g. an AsyncAPI contract), as opposed to an internal-only fact. Plain structural flag, no
  free text and no diagram marker (same posture as `again`). Write it as the last token on the
  line, optionally right before a trailing `@Context` — `event X @Context public` or
  `event X public @Context` both work. `em export` carries it as `public: true`/`false`;
  `em diff` reports a flip as `event marked public`/`event unmarked public`;
  `em validate --list-public` audits which events are public.
- **Fields:** `command Place Order { orderId: UUID, items: LineItem[], customerId }` — inline or
  one-per-line. Types are free text (no semantic checking) UNLESS the type string names a
  declared `type` (see Named types below), in which case it resolves to a structured
  reference. Keep these light; full field specs with rules live in the slice doc.
- **Comments:** `# ...` anywhere outside quotes (full-line or trailing).
- **`source "url"` on a slice header** (the only slice-level clause — everything above is
  per-element) links the slice back to the ticket/conversation it traces to, e.g.
  `slice "Checkout" source "https://linear.app/team/issue/MIL-60" { ... }`. Exports as
  `model.slices[].source` via `em export`, so an intake loop stays machine-traversable instead
  of relying on prose. Purely metadata — no visual marker, not validated. Don't confuse it with
  an element's `note "path.md"` (a markdown file link, not a URL).

### Named types

`type Name { field: Type, ... }` declares a reusable structured shape at the top level (any
order relative to `persona`/`context`/`slice`, no clauses). Reference it from any field
anywhere — bare (`winner: QuoteAcceptedLine`) for a nested object, `Name[]` for an array
(`lines: QuoteAcceptedLine[]`). Resolution is opportunistic: a type string only becomes a
structured reference when it names a declared type (case/whitespace-insensitive match); every
other type string stays free text exactly as before, so declaring no `type` blocks changes
nothing. Recursion between declared types is allowed as a DAG (e.g. a diamond shape like
`Order` referencing `Address` twice) — a bare/singular self- or mutual-cycle
(`type Node { child: Node }`) is a validation error, but the same shape through an array
(`type Node { children: Node[] }`) is legal since the array can terminate at runtime; this is
how tree/recursive data (categories, org charts, comment threads, BOMs) gets expressed.
`em export` lists every declared type under `model.types[]` (stable `ref`, e.g.
`types/quote-accepted-line`) and adds an additive `typeRef` key to every field (declared-type
fields and ordinary element fields alike) — `{ name, ref, array }` when resolved, `null`
otherwise. `em diff` tracks types added/removed and field changes on surviving types.

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

# 4a. Translation (external trigger, no durable artifact): external call -> translation -> command -> event
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

# 4b. Translation (external trigger, durable artifact): persisted inbound queue -> translation -> command -> event
slice "Receive Carrier Event" {           # ingest: persist the raw webhook before reacting to it
  ui Webhook Endpoint @Carrier
  command Receive Carrier Event
  event Carrier Event Received @Shipping  # scoped to @Shipping's fact, not the @Carrier caller
}
slice "Inbound Carrier Events" {
  view Inbound Carrier Events from "Carrier Event Received"   # the persisted inbound queue
  translation Carrier Adapter
}
slice "Acknowledge Carrier Event" {
  command Acknowledge Carrier Event
  event Carrier Event Acknowledged @Shipping
}
slice "Inbound Carrier Events — processed" {
  view Inbound Carrier Events again from "Carrier Event Acknowledged"
  ui Delivery Board @Ops
}

# 4c. Translation (internal trigger, durable artifact): read model -> translation -> command -> event
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

Trigger source (external/internal) and durable artifact (`view`-backed or not) are independent
axes — 4a and 4b are both "externally triggered" but only 4b has a queue, and a `view`-backed
translation reacts the same whether the view was filled by an outside system (4b) or the model's
own event (4c). An inbound message earns `event` status the same way any event does: scope it to
the context/lane whose fact it represents (e.g. `Carrier Event Received @Shipping` or its own
`Carrier` context), not by who committed it — that keeps it a legitimate boundary fact (à la an
Anti-Corruption-Layer event in DDD) instead of a technical artifact leaking foreign vocabulary
into the model.

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
  4a/4b/4c Translation examples above, unchanged). It is **not** how you model a synchronous
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
- A `ui` never triggers a reaction — no pattern has a `ui` wired to `processor`/`automation`/
  `saga`/`translation`, only to `command`. A `ui` left in the reaction's own slice (instead of the
  read-model or command slice) renders with no outgoing edge, disconnected, and `em validate` now
  warns on it.

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
8. **Cyclic type reference** — a declared `type` nesting itself with no array to terminate it
   (`type Node { child: Node }`, or the same shape across several types). Break the cycle, or
   route the self/mutual reference through an array (`children: Node[]`) if the data is
   genuinely tree-shaped.

**Warnings (should fix):**
1. **Automation/translation shares slice with its command** — both `automation`/`processor` and
   `translation` are reactions; put the triggered command in the *next* slice.
2. **`ui` shares slice with a reaction, no command** — a `ui` only ever wires to a `command`; no
   pattern has a `ui` triggering an automation/processor/saga/translation. Left in the reaction's
   own slice it renders disconnected, with no edge. Move it to the read-model slice, or to the
   slice with the command this eventually triggers.
3. **Command with no trigger** — nothing issues it. A command needs a `ui` in its slice, or a
   reaction (automation/processor/saga/translation) in the slice *before* it. The input-side mirror
   of (5): a command nothing points at is a write nobody can start.
4. **Command without event** — every command should record at least one event.
5. **Event nobody reads** — the mirror of (4): recording an event no read model projects is a
   write with no reader. Follow every write slice with the read slice that consumes its event.
   Counts as read when a `view` names it in `from` (any `again` instance will do), when a
   fieldless-`from` view sits in its slice, or via an explicit `event -> view` arrow.
6. **Read model without source** — add `from "Event"` or place the view in a slice with an event.
7. **Duplicate name** — the same name defined N times; references resolve to the first. Rename.
   (A duplicate `type` name always warns, unlike a duplicate element name — there's no
   legitimate unreferenced-duplicate case for a named type.)
8. **Open issue** — an element carries `issue "text"`; resolve the question, then remove the
   clause. `em validate --list-issues` prints just these; `--fail-on-issues` (opt-in) makes CI
   fail while any remain open.
9. **View field with no source** — a `view` field whose name matches no field on any instance
   of its source events. Only checked once BOTH the view and at least one source event declare
   `{ fields }`.
10. **Event field not from a command** — an `event` field whose name matches no field on any
    command in the same slice. Only checked once BOTH the event and at least one same-slice
    command declare `{ fields }`. This is the payoff of the fields feature for slicing rigor:
    once fields are written down, `em validate` checks that data flows forward consistently.

`divergence "text"` is deliberately NOT in this list — it raises no warning at all, since it
records a deviation already reasoned through and accepted, not something to fix. Use
`em validate --list-divergences` to audit them on demand.

### Full rule code reference

Every rule above (and every fs-aware check `em validate` layers on top — lineage, frontmatter
coherence) has a stable `code`, generated below from the same registry `em` itself validates
against (`src/model/rules.ts`) — a new rule shows up here the moment it's registered, whether or
not the prose above has caught up yet. `--slice-ready <key>`-only codes are excluded; see
[cli.md](../../../../docs/cli.md#em-validate-file).

<!-- GENERATED:validate-rules:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
| Code | Severity | Title | Fix |
|---|---|---|---|
| `arrow-backward` | error | Backward arrow | Restructure so the target comes later. |
| `arrow-unresolved-source` | error | Arrow source unresolved | Fix the arrow's source name. |
| `arrow-unresolved-target` | error | Arrow target unresolved | Fix the arrow's target name. |
| `automation-shares-slice-with-command` | warning | Automation shares slice with its command | Put the triggered command in the next slice. |
| `binding-missing-file` | warning | Doc binding points at a missing file | Create the slice doc, or fix the `note` path. |
| `both-ends-of-a-flow/command-no-event` | warning | Command without event | Add the event this command records. |
| `both-ends-of-a-flow/command-untriggered` | warning | Command with no trigger | Add a `ui` in this slice, or a reaction in the previous slice. |
| `both-ends-of-a-flow/event-unproduced` | warning | Event with no producing command | Add the command that records it, or an explicit arrow from one. |
| `both-ends-of-a-flow/event-unread` | warning | Event nobody reads | Project it into a view, or reconsider recording it. |
| `both-ends-of-a-flow/ui-unbacked` | warning | `ui` with no read model or command | Add a `view` it displays, or the command it triggers. |
| `both-ends-of-a-flow/view-unconsumed` | warning | Read model with no consumer | Add a `ui` or reaction that consumes it, or drop this instance. |
| `connection-legality/illegal-pair` | error | Illegal connection | Only ui→command→event→view→ui and view→reaction→command are legal — the message names the missing step. |
| `duplicate-element-ref` | warning | Duplicate element ref | Rename the element so its export ref is unique. |
| `duplicate-name` | warning | Duplicate name | Rename one of the duplicates. |
| `duplicate-slice-name` | warning | Duplicate slice name | Rename the slice so its export key is unique. |
| `duplicate-type-name` | warning | Duplicate type name | Rename one of the duplicate `type` declarations. |
| `duplicate-type-ref` | warning | Duplicate type ref | Rename the type so its export ref is unique. |
| `fields-completeness/event-field-no-source` | warning | Event field not from a command | Add the field to a command in the slice, or remove it from the event. |
| `fields-completeness/view-field-no-source` | warning | View field with no source | Add the field to a source event, or remove it from the view. |
| `frontmatter-coherence-implemented-without-link` | warning | Implemented without a link | Add `implementedIn` once the slice ships. |
| `frontmatter-invalid` | warning | Invalid or missing frontmatter | Add the required frontmatter keys, or add a frontmatter block. |
| `grid-collision` | error | Band collision | Split the colliding elements into separate slices. |
| `lineage-forward-dangling` | error | Dangling forward lineage ref | Fix the key, or remove the stale successor. |
| `lineage-ref-cycle` | error | Lineage cycle | Break the cycle — a slice can't be its own ancestor. |
| `lineage-ref-malformed` | error | Malformed lineage ref | Fix the value to `<slice-key>@v<N>`, or remove it. |
| `lineage-version-impossible` | error | Impossible lineage version | Fix the referenced version, or ratify the target slice first. |
| `open-issue` | warning | Open issue | Resolve the question, then remove the `issue` clause. |
| `reaction-from-future-view` | error | Backward timeline (reaction reads a future view) | Declare the view in or before the reaction's slice. |
| `reaction-from-unresolved` | error | Unknown read-model source | Project the event into a view first, or fix the `from` reference. |
| `translation-name-collision` | warning | Translation name reused for different producers | Use a distinct name per producer to avoid confusion. |
| `type-cycle` | error | Cyclic type reference | Break the cycle, or route the self/mutual reference through an array. |
| `ui-shares-slice-with-automation` | warning | `ui` shares slice with a reaction, no command | Move the `ui` to the read-model slice, or to the slice with the command this triggers. |
| `view-again-without-earlier` | error | `again` without an earlier declaration | Declare the view plainly the first time it appears. |
| `view-from-future-event` | error | Backward timeline (view reads a future event) | Move the source to a later `view X again` instance. |
| `view-from-unresolved` | error | Unknown event source | Fix the `from` reference to name an existing event. |
| `view-no-source` | warning | Read model without source | Add `from "Event"`, or place the view in a slice with an event. |
<!-- GENERATED:validate-rules:end -->

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
