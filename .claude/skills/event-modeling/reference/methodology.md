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

**Automations and translations are not exceptions to rule 1.** They are *reactions* — a processor
or an adapter that wakes up, decides something must change, and **issues a command** to do it. They
never record an event themselves. A reaction box always points at a **command** (in the next
slice), and that command produces the event. If you ever see a translation or automation wired
straight to an event, the model is wrong.

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
- `em` shape: `slice { ui X @Persona  command Y  event Z @Context }`
- This is where **invariants** live — the command is rejected if a rule is violated.
- Socratic prompts: *"What does the user do here? What request are they making? What must be
  true for it to succeed? What fact gets recorded when it does? What gets rejected and why?"*

### 2. State View (View pattern)
**Event(s) → Read Model → UI.** Past events are projected into a read model that a screen
displays. Read-only; changes no state.
- `em` shape: `slice { view V from "Event A", "Event B"  ui Screen @Persona }`
- **Headless / API systems (no UI):** when there is no UI, a read model is consumed by an
  **external caller querying the API**, modeled as a **read translation** — the outbound analog of
  `→ ui`. Shape: `slice { view V from "..."  translation <Caller> Read <V> }`. A read translation
  **triggers no command** (it returns data); it is *not* a reaction, so the
  `reaction → command → event` rule does **not** apply to it. (Contrast: a *reaction* translation in
  pattern 4 triggers a command.)
- **Repeat read models across the timeline.** A read model is drawn fresh in **every** slice where
  it is read — after the events that update it, before the actions that consume it — so the diagram
  shows state flowing left-to-right (the information-completeness staircase). The same read-model
  name recurring is intentional and **renders cleanly**: `em validate` only warns about a duplicate
  name that is *also referenced* by a `from`/`arrow` (it resolves to the first), so a repeated read
  model that nothing references by name produces **no warning**. **Wire each event to a read model
  exactly once:** a repeated instance's `from` lists only the **new** events since the previous
  instance (not cumulative) — otherwise an event draws a duplicate arrow to the same read model at
  every repeat. (An event may still feed several *different* read models, once each.)
- **Place each repeat immediately after its feeding event (span-1).** The cleanest staircase puts a
  read-model instance right after each event that updates it, sourcing **only that one adjacent
  event** — every `event → read model` arrow is then short and forward-flowing. A read model sitting
  far from its source events (e.g. a "list/queue" read placed early but fed by late events) draws
  long arrows that cross the read-model row and *look* like read→read connections — which Event
  Modeling forbids. The fix is never a `view → view` edge; it's to repeat the read model next to each
  event that feeds it.
- Socratic prompts: *"What does the consumer need to see to make their next decision? Which past
  events provide that information? Is this a screen or an API read? What's the freshness/consistency
  expectation?"*

### 3. Automation (Processor pattern)
**Read Model → Processor → (next slice) Command → Event.** The system reacts on its own: a
processor watches a read model (a "to-do list" of work) and **issues a command** — it never
records an event directly.
- `em` shape: **two slices.** First `slice { view "Todo" from "..."  processor P }`, then the
  **next** `slice { command C  event E @Context }`. The processor band holds no event; the command
  in the next slice produces it. Keeping the triggered command in the same slice as the processor
  is a validation warning — always split it.
- Socratic prompts: *"What should happen without a human? What condition triggers it? What work
  list does the processor watch? What command does it fire? What if it fails or retries?"*

### 4. Translation
**Boundary crossing → command → event.** An adapter translates data across a boundary (an external
system, or another bounded context) into the model's own language. Like an automation, a
translation is a *reaction*: it **triggers a command**, never records an event directly. Two
trigger forms:
- **Externally triggered:** `external input → translation → command → event`. The trigger comes
  from outside the model, so the translation has no internal `from`.
- **Internally triggered** (reacting to the modeled system's own state, e.g. pushing data out):
  `read model → translation → command → event`. The translation reads a **view** via `from`.
- `em` shape: **two slices**, exactly like an automation. First
  `slice { [view "Source" from "..."]  translation T [from "Source"] }`, then the **next**
  `slice { command C  event E @Context }`. The translation band never carries an event.
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
wire them correctly — especially **split both automations and translations across two slices**
(the reaction in one, the command + event in the next). A translation or automation never records
an event directly; it triggers a command.
- Prompts: *"Which events belong together as one consistency boundary (aggregate)? Who owns this
  data? Is this slice a state change, a view, an automation, or a translation?"*
- Output: a structurally complete model with swimlanes and pattern-correct slices.

### Step 6 — Elaborate Scenarios  *(model first pass, slice deep pass)*
For each slice, write **Given / When / Then** scenarios and surface **invariants**, **critical
fields**, and **alternate / error flows**. In the `model` phase do a light first pass; the
dedicated `slice` phase writes the full rich spec (see `templates/slice.md`).
- Prompts: *"Given what starting state, when this command/trigger fires, then what event(s)
  result? What must always be true? What are the failure paths? Which fields are essential and
  what are their rules?"*
- Output: rich slice docs linked into the `.em` via `note "slices/<name>.md"`.

### Step 7 — Evaluate Completeness  *(model)*
Walk the whole model with stakeholders and check for loose ends:
- Every **command** produces at least one **event**.
- Every **view** has at least one source event.
- Every **event** is shown somewhere or consumed by something (no orphan facts).
- Every **UI** is reachable and leads somewhere.
- Automations **and** translations are split correctly (reaction → command → event, never a
  reaction wired straight to an event); translations cover every external input.
- Run `em validate` and resolve all errors and warnings. Note: `em validate` does **not** catch a
  translation/automation that emits an event directly — verify the two-slice split by hand.
- Prompts: *"Is there any event nobody sees? Any screen with no way in or out? Any command that
  records nothing? Any external system we haven't translated? Any translation or automation that
  records an event instead of triggering a command?"*

---

## Socratic stance (applies throughout)

- Ask **one focused question at a time**; never assume a domain fact — extract it.
- Prefer "why", "what if", "who", "what must always be true", "how do you know" over yes/no.
- Mirror the model back after each increment and **re-render** so the team sees it evolve.
- Park unresolved questions in the state file instead of guessing.
- Name things crisply: events past-tense, commands imperative, views as the thing-shown.
