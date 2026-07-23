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
  event Free Text @Context       # recorded fact; @Context picks its row (defaults to "Domain")
  processor Free Text from "View"   # automation; aliases: automation | saga | translation
}

arrow From Element -> To Element    # explicit cross-slice edge (overrides inferred flow)
```

### Element kinds (8 keywords, nothing else)
| Keyword | Band | Meaning | Tag | Extra clauses |
|---|---|---|---|---|
| `ui` | persona | screen / interface | `@Persona` | `note`, `{ fields }` |
| `command` | API | state-changing request | — | `note`, `{ fields }` |
| `view` | API | read model / projection | — | `from "Event"…`, `note`, `{ fields }` |
| `event` | context | recorded fact (past tense) | `@Context` | `note`, `{ fields }` |
| `processor` / `automation` / `saga` / `translation` | automation | system reaction / adapter | — | `from "…"`, `note`, `{ fields }` |

### Clauses
- **Tags:** `@Persona` only on `ui`; `@Context` only on `event`. Undeclared tags auto-create a row.
- **`from "X"`** on views/automations declares the source(s); names are quoted, comma-separated.
  Matching is case-insensitive and whitespace-normalized.
- **`note "path.md"`** on ANY element links a markdown doc. Relative to the `.em` file. Renders as
  a clickable marker in SVG and a legend entry in PNG/PDF. **This is how slice docs attach.**
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

# 3. Automation: split across TWO slices
slice "Orders To Fulfill" {
  view Orders To Fulfill from "Order Placed"
  processor Fulfillment Service
}
slice "Ship Order" {            # the triggered command goes in the NEXT slice
  command Ship Order
  event Order Shipped @Shipping
}

# 4a. Translation (external trigger): external input -> translation -> command -> event
slice "Carrier Webhook" {
  translation Carrier Adapter         # inbound from outside the model; no internal `from`
}
slice "Confirm Delivery" {            # the triggered command goes in the NEXT slice
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}

# 4b. Translation (internal trigger): read model -> translation -> command -> event
slice "Quotes To Sync" {
  view Accepted Quotes from "Quote Accepted"
  translation CRM Sync                # reacts to our own state via the read model in this slice
}
slice "Record Sync" {
  command Record Crm Sync
  event Quote Synced @Quote
}
```

A `translation` (like a `processor`) is a **reaction**: it triggers a command and never carries an
`event` in its own slice. Same two-slice split as the Automation pattern above.

### Headless / API systems (no UI) & repeated read models

When the system is headless (no UI — clients call an API), drop `ui`/`persona` entirely:

```em
# Write: external translation -> command -> event (name the inbound adapter for the caller/role)
slice "Create Quote (request)" { translation SalesRep BU Create Quote }
slice "Create Quote"           { command Create Quote  event QuoteCreated @Quote }

# Read: event(s) -> read model -> READ translation (the external caller's API query, replaces UI)
slice "Read Quote — created"   { view Quote from "QuoteCreated"  translation SalesRep BU Read Quote }
```

- A **read translation triggers no command** (it returns data outbound) — it is the headless analog
  of `view → ui`, *not* a reaction. Only *reaction* translations/processors trigger commands. A read
  slice has no `command` and no `event`, so `em validate` stays quiet about it.
- **Repeat the read model** in every slice where it's read so the timeline flows left-to-right.
  Recurring `view`/`translation` names **render cleanly and stay warning-free** as long as nothing
  references the repeated name via `from`/`arrow` (the duplicate-name warning fires only for a
  *referenced* duplicate, resolving to the first). **Wire each event to a read model exactly once:**
  a repeated instance's `from` lists only the **new** events since the previous instance (not
  cumulative), or the event draws a duplicate arrow to the same read model at every repeat. (An
  event may still feed several *different* read models, once each.)
- **Keep arrows span-1: put each repeat right after its feeding event.** Place a read-model instance
  immediately after the event that updates it, sourcing only that single adjacent event. A read
  model far from its source events draws long arrows that cross the read-model row and read as
  read→read (an Event Modeling violation) — repeat the read model next to each event instead.

### Slice-ordering gotchas (edge inference)

`em` infers cross-slice arrows positionally, so **slice order matters**:
- A **reaction** (`processor`/`translation` that triggers a command) wires to the command in the
  **immediately next** slice. So a reaction slice must be *directly* followed by its command slice —
  don't insert a read slice between them.
- A **read** slice (read model → read translation, no command) must **not** be immediately followed
  by a `command` slice, or the read translation will be mis-wired to that command. Put reads after a
  command+event slice, or before another read / a reaction / an inbound `(request)` slice.
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

**Warnings (should fix):**
1. **Automation/translation shares slice with its command** — both `automation`/`processor` and
   `translation` are reactions; put the triggered command in the *next* slice.
2. **Command without event** — every command should record at least one event.
3. **Read model without source** — add `from "Event"` or place the view in a slice with an event.
4. **Duplicate name** — the same name defined N times; references resolve to the first. Rename.

**Design rules that keep models valid:**
- One element per band per slice (multiple personas/contexts are fine — they're different rows).
- Every `command` slice includes its `event`. Every `view` has a `from` source.
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
