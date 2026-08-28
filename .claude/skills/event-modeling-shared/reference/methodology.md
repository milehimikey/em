# Event Modeling — Methodology Reference

This is the authoritative reference for the **7 steps** and **4 patterns** of Event Modeling
(Adam Dymitruk's method). Consult it while running any phase of the `event-modeling` skill.
Do not invent domain facts — use the Socratic prompts to extract them from the user.

---

## Core idea

An event model is a **timeline of state changes** told as a story. Information only moves
three ways:

1. **Into** the system via a **command** (a request to change state) → produces an **event**.
2. **Out of** the system via a **read model / view** (a projection of past events) → shown on a **UI** or consumed by an automation.
3. There is **no other way** for information to flow. Every box on the diagram is one of:
   UI screen, command, event, read model, or automation/processor.

Concretely, that leaves exactly six legal connections, and `em` infers only these:
`ui → command`, `command → event`, `event → read model`, `read model → ui`,
`read model → reaction`, `reaction → command`. Every other pair is a rule violation, and an
explicit `arrow` writing one is a validation error. The two worth naming, because they are the
tempting shortcuts:

- **`command → read model`** — the CQRS violation. A write is only ever visible to a reader
  through the event it recorded. Put the event between them.
- **`read model → command`** — reads never drive a write directly. A processor or translation
  watches the read model and issues the command that sits in the same slice.

If you find yourself wanting an arrow the patterns don't allow, the model is missing an
**element**, not an arrow.

**Automations and translations are not exceptions to rule 1.** They are *reactions* — a processor
or an adapter that wakes up, decides something must change, and **issues a command** to do it. They
never record an event themselves. A reaction box always points at a **command in its own slice** —
the same shape a `ui` already uses in State Change — and that command produces the event. If you
ever see a translation or automation wired straight to an event, the model is wrong.

Events are **immutable past-tense facts** ("Order Placed", "Payment Captured"). They are the
spine of the model. Everything else hangs off the events.

The unit of delivery is a **slice**: a thin vertical cut through the swimlanes that delivers
one of the four patterns. A slice is what a developer implements and tests in isolation.

---

## The 4 patterns

Every slice is exactly one of these. In `em`, each maps to a specific shape (see `em-dsl.md`).

### 1. State Change (Command pattern)
**UI → Command → Event.** A user (or automation) submits a command; the system validates it
against invariants and records one or more events.
- **A State Change never travels alone, and it's joined at both ends.** Something must *trigger*
  the command — the `ui` it's issued from, or (patterns 3 and 4) the reaction that triggers it,
  also in this slice — and its event needs a read model that projects it. So the unit of work is a State Change
  slice *plus* the State View slice that reads its event. Write them together; a command nothing
  points at is a write nobody can start, an unread event is a write nobody can see, and
  `em validate` warns on each.
- `em` shape (one element per line — there is no one-line slice form):
  ```em
  slice "Do The Thing" {
    ui X @Persona
    command Y
    event Z @Context
  }
  slice "See The Result" {   # the State View slice that reads Z — pattern 2, but required here
    view V from "Z"
    ui Screen @Persona
  }
  ```
- This is where **invariants** live — the command is rejected if a rule is violated.
- Socratic prompts: *"What does the user do here? What request are they making? What must be
  true for it to succeed? What fact gets recorded when it does? What gets rejected and why?"*

### 2. State View (View pattern)
**Event(s) → Read Model → UI.** Past events are projected into a read model that a screen
displays. Read-only; changes no state.
- `em` shape: `slice { view V from "Event A", "Event B"  ui Screen @Persona }`
- **Headless / API systems:** still use `ui`/`persona` — declare a persona per external
  caller/role (e.g. `IntegratorAPI`) and treat its `ui` boxes as API calls, not screens. Shape:
  `slice { view V from "..."  ui Read V @IntegratorAPI }`, same as any State View slice.
  `translation` stays reserved for genuine reactions/external-system boundaries (pattern 4), not
  for a synchronous request/response API call.
- **Repeat read models across the timeline.** A read model is drawn fresh in **every** slice where
  it is read — after the events that update it, before the actions that consume it — so the diagram
  shows state flowing left-to-right (the information-completeness staircase). The same read-model
  name recurring is intentional and **renders cleanly**. Declare every instance after the first with
  **`view V again from "..."`**: `again` instances are exempt from the duplicate-name warning even
  when something references them, and each reference resolves to the right instance. (A plain repeat
  only stays warning-free while nothing references it by name, and resolves to the *first*
  declaration when something does.) **Wire each event to a read model
  exactly once:** a repeated instance's `from` lists only the **new** events since the previous
  instance (not cumulative) — otherwise an event draws a duplicate arrow to the same read model at
  every repeat. (An event may still feed several *different* read models, once each.)
- **Instances are never connected to one another.** There is no arrow between two appearances of one
  read model, and an explicit one is a validation error. The repeat is an ergonomic device for
  showing the same read model at successive points in time — continuity is implied by the shared
  name, and the events arriving at each instance are what show it changing. An arrow between them
  would say the read model feeds itself.
- **Place each repeat immediately after its feeding event (span-1).** The cleanest staircase puts a
  read-model instance right after each event that updates it, sourcing **only that one adjacent
  event** — every `event → read model` arrow is then short and forward-flowing. A read model sitting
  far from its source events (e.g. a "list/queue" read placed early but fed by late events) draws
  long arrows that sweep across the diagram. The renderer routes them *around* intervening boxes
  rather than through them, so they no longer *look* like a forbidden read→read link — but the
  distance itself is the problem: the arrowhead lands columns away from the event that produced it,
  so **the write slice reads as dangling**, as if nothing consumed its event. A reader has to trace
  the line across the diagram to see otherwise. The fix is never a `view → view` edge; it's to
  repeat the read model next to each event that feeds it, and to keep a sub-flow that detours into
  another context together rather than parking it at the end of the model.
- Socratic prompts: *"What does the consumer need to see to make their next decision? Which past
  events provide that information? Is this a screen or an API read? What's the freshness/consistency
  expectation?"*

### 3. Automation (Processor pattern)
**Read Model → Processor → Command → Event, the last three together in one slice.** The system
reacts on its own: a processor watches a read model (a "to-do list" of work) and **issues a
command** — it never records an event directly.
- `em` shape: the read model in the slice before, then the reaction with its command and event —
  plus the read slice that consumes the event — three slices in all:
  ```em
  slice "Todo" {
    view Todo from "..."
  }
  slice "Do It" {           # processor, command, and event all share this slice
    processor P from "Todo"
    command C
    event E @Context
  }
  slice "Todo — done" {
    view Todo again from "E"   # every event needs a reader; here it clears the to-do list
    ui Work Board @Persona     # ...and every read model needs a consumer
  }
  ```
  The processor never records the event directly — the command it triggers does, and that event
  happens to live in the processor's own slice now because the command does. A processor with no
  command in its slice (and no explicit arrow to one) is a validation warning: a decision the
  system never acts on. Forgetting the third slice leaves `E` unread, which is also a warning.
- **Naming:** name the read model after the pending work — `Payments To Process`,
  `Orders To Fulfill`, `Pending Approvals` — never after the triggering event. The event is what
  happened; the view is what's left to do. Reusing the event's name also collides in the shared
  element namespace: `from` references then resolve by element kind, and `em validate` flags the
  duplicated name.
- Socratic prompts: *"What should happen without a human? What condition triggers it? What work
  list does the processor watch? What command does it fire? What if it fails or retries?"*

### 4. Translation
**Boundary crossing → command → event, the reaction and what it triggers together in one slice.**
An adapter translates data across a boundary (an external system, or another bounded context) into
the model's own language. Like an automation, a translation is a *reaction*: it **triggers a
command**, never records an event directly. Two independent questions shape which form it takes —
don't conflate them:
- **Trigger source:** does the input come from outside the model, or from the model's own state
  pushed back out?
- **Durable artifact:** is there a queryable, persisted thing behind the trigger (a queue, topic,
  or log), or is it an ephemeral call with nothing to query afterward?

The `em` shape only tracks the second question — trigger source doesn't change it:
- **No durable artifact:** `external input → translation → command → event`. No internal `from`.
  Typically (not necessarily) externally triggered — a bare webhook call with nothing persisted
  behind it.
- **Durable artifact:** `read model → translation → command → event`. The translation reads a
  **view** via `from`. This shape is the same whether the view was filled by the model's own event
  (internally triggered, e.g. pushing data out) or by an external system's persisted queue
  (externally triggered, e.g. a webhook whose inbound message is stored first for retries,
  ordering, or audit) — an externally triggered translation backed by a real queue is
  architecturally closer to this case than to the no-artifact one above.
- **Event legitimacy:** a received external message counts as a legitimate domain `event` when
  it's scoped to the context/lane whose fact it represents, not by who committed it — the same
  move as an Anti-Corruption-Layer boundary event in DDD — and stays legitimate as long as it
  doesn't leak into the model's own domain vocabulary.
- `em` shape: exactly like an automation — the read model (durable-artifact form only) in the
  slice before, then the reaction with its command and event, plus the read slice for the event:
  ```em
  slice "Boundary" {
    view Source from "..."     # durable-artifact form only; omit if there's nothing persisted
  }
  slice "Record It" {          # translation, command, and event all share this slice
    translation T from "Source"   # omit `from` entirely for the no-durable-artifact form
    command C
    event E @Context
  }
  slice "Source — recorded" {
    view Source again from "E"   # every event needs a reader
    ui Status Screen @Persona    # ...and every read model needs a consumer
  }
  ```
  The translation never records the event directly — the command it triggers does.
- Socratic prompts: *"What boundary are we crossing, and which way? What outside system or context
  feeds us (or do we feed)? In what format? How do we know its data is trustworthy/complete? What
  internal **command** does it trigger, and what event does that command record?"*

---

## The 7 steps

Run them in order. The skill groups them into phases: **discover = 1–4**, **model = 5–7**,
and a dedicated **slice** phase deepens step 6 to implementation-ready specs.

### Step 1 — Brainstorm Events  *(discover)*
List the domain **events** as past-tense facts, unordered at first. Go wide; capture every
state change anyone can think of. No commands, no UI yet — just facts.
- Prompts: *"What are all the things that happen in this process? Say each as something that
  already occurred. What changed when that happened?"*
- **Is it an event?** Events here are *business* facts, not technical ones. Test: if this fact
  failed to occur, would it wake the CEO at 3am? Yes → event. No → not an event.
  - **Yes:** Order Created, Item Added to Order, Order Shipped, Order Delivered, Order
    Cancelled, User Registered, Item Provisioned.
  - **No — derived values** (a read model computes these from other events; they aren't
    independent facts): Order Total Calculated, Order Tax Calculated, Discount Applied.
  - **No — activity, not business state** (telemetry, not something the domain decides on):
    User Clicked Button, User Viewed Page, User Logged In.
- Model the process the business **needs**, not how the current system happens to work. Existing
  system behavior is a common source of fake events — screens and tables leaking in as facts.
  (**Extract mode inverts this**: in the `event-modeling-discover` skill's `extract` phase the
  existing system *is* the subject and this caution is deliberately suspended — see the
  "Extract" section below and `event-modeling-discover`'s own `reference/extract.md`. The
  derived-value and telemetry filters still apply there.)
- Output: a flat list of candidate `event` names.

### Step 2 — The Plot / Storyboard  *(discover)*
Put the events in **timeline order** to form the narrative. Identify the **personas** (actors)
and sketch the **UI** screens that move the story forward. This is the storyboard.
- Prompts: *"In what order do these happen? Who is on screen at each step? What screen are they
  looking at? What's the happy-path story start to finish?"*
- Output: ordered events + `persona` list + `ui` screens per step.

### Step 3 — Inputs (Commands)  *(discover)*
For each event, identify the **command** that causes it (State Change pattern). Name the intent,
not the outcome ("Place Order", not "Order Placed").
- Prompts: *"What action produces this event? Who or what issues it? Could it be refused?"*
- Output: `command → event` pairs.

### Step 4 — Outputs (Read Models)  *(discover)*
Identify the **read models / views** each UI and automation needs (State View pattern). Wire
each view to the events that feed it.
- Prompts: *"What information does this screen show? Which past events supply it? Does any
  automation need a work list derived from events?"*
- Output: `view` elements with their `from "Event"` sources.

### Step 5 — Swimlanes & Apply the Patterns  *(model)*
Organize elements into swimlanes: one **persona** row per actor, one **context** (bounded
context / aggregate) row per event family. Classify every slice as one of the **4 patterns** and
wire them correctly — especially **share the slice between every automation or translation and the
command it triggers** (the read model it watches, if any, stays in the slice before). A translation
or automation never records an event directly; it triggers a command.
- Prompts: *"Which events belong together as one consistency boundary (aggregate)? Who owns this
  data? Is this slice a state change, a view, an automation, or a translation?"*
- Output: a structurally complete model with swimlanes and pattern-correct slices.

### Step 6 — Elaborate Scenarios  *(model first pass, slice deep pass)*
For each slice, write **Given / When / Then** scenarios and surface **invariants**, **critical
fields**, and **alternate / error flows**. In the `model` phase do a light first pass; the
dedicated `slice` phase writes the full rich spec (see `../templates/slice.md`).
- Prompts: *"Given what starting state, when this command/trigger fires, then what event(s)
  result? What must always be true? What are the failure paths? Which fields are essential and
  what are their rules?"*
- **Existing codebase:** before finalizing field names/types, check adjacent real sources
  (OpenAPI specs, DB migrations, existing DTOs/event classes in sibling contexts) rather than
  guessing — mirrors `extract.md`'s whole-system grounding, applied per-slice.
- Output: rich slice docs linked into the `.em` via `note "slices/<name>.md"`.

### Step 7 — Evaluate Completeness  *(model)*
Walk the whole model with stakeholders and check for loose ends:
- Every **command** has something that **triggers** it — a `ui` in its slice, or the reaction that
  triggers it, also in its slice. A command nothing points at is a write nobody can start.
  `em validate` warns.
- Every **command** produces at least one **event**.
- Every **view** has at least one source event, **and a consumer** — a `ui` (headless: the `ui`
  tagged to the API-caller persona), or a reaction watching it. Every *instance* of a repeated
  view, not just the last one.
  A read model nothing displays is information projected out and then dropped. `em validate` warns.
- Every **event** is **read by a read model** — a `view` naming it in `from` (any `again` instance
  counts), or a `view` with no `from` sitting in its slice. A reaction consuming it does **not**
  count: reactions read views, not events. An event nothing projects is a write nobody can see, so
  there was no point recording it. `em validate` warns on each one.
- Every **UI** is reachable and leads somewhere.
- Every connection is one of the six legal pairs (`ui → command`, `command → event`,
  `event → read model`, `read model → ui`, `read model → reaction`, `reaction → command`). No
  arrow between two instances of one read model.
- Automations **and** translations are wired correctly (reaction → command → event, all in one
  slice — never a reaction wired straight to an event, and never a reaction with no command at
  all); translations cover every external input.
- Run `em validate` and resolve all errors and warnings. It catches illegal `arrow` kind pairs
  (error), unread events (warning), and a reaction with no command in its slice (warning) — a
  reaction wired straight to an event with no command anywhere is exactly what that last check
  catches, so a clean `em validate` run does cover this case.
- Prompts: *"Is there any event nobody reads — and if the business genuinely never looks at it, why
  are we recording it? Any command that just happens, with nobody and nothing asking for it? Any
  screen with no way in or out? Any command that records nothing? Any
  external system we haven't translated? Any translation or automation that records an event instead
  of triggering a command?"*

---

## Extract: current-state models of existing systems

The `extract` phase derives a model from an **existing** system instead of a greenfield
conversation. It is discover's as-is sibling: its confirm-and-clarify rounds converge the same
step 1–4 outputs (events, timeline, commands, read models) — *derived from the system*, then
confirmed with the user — after which the model enters `model` (steps 5–7) as usual.

The stance inversion, stated authoritatively: **extraction captures how the system behaves
today — faithfully, warts included — and never invents future or desired state.** Step 1's
anti-current-system caution is suspended for the duration; the "is it an event?" filter is
not — derived values and telemetry are still rejected even when the current system emits them.
Unknown or ambiguous current behavior is parked, never guessed — mirrored in the state file's
Open Questions, and on the element itself with `issue "text"` when it should also show up on the
rendered diagram (preferred over a bare `# TBD` comment, which is invisible once rendered).
Desired-state improvements belong to the `model` and `slice` phases, after the as-is picture is
agreed.

Procedure, source modes (event-driven vs. procedural synthesis), and the round-by-round loop:
the `event-modeling-discover` skill's own `reference/extract.md`.

---

## Socratic stance (applies throughout)

- Ask **one focused question at a time**; never assume a domain fact — extract it.
- Prefer "why", "what if", "who", "what must always be true", "how do you know" over yes/no.
- Mirror the model back after each increment and **re-render** so the team sees it evolve.
- Park unresolved questions in the state file instead of guessing.
- Name things crisply: events past-tense, commands imperative, views as the thing-shown.
- **Live workshop, one chat interface:** route through a single human proxy who relays questions
  to the room and reports answers back; attribute every answer/decision in the Decisions log to
  the named participant who gave it (see the state file's Participants section).
