# The four patterns

Event Modeling builds every system from four patterns, and every slice in a `.em` model is
meant to be exactly one of them. The discipline behind the patterns: information moves
**into** the system through a command that records an event, **out of** the system through a
read model, and no other way. Automations and translations are not exceptions — they are
reactions that issue a command, which then records the event, in the same slice as the
reaction.

(Mechanically, `em export` classifies a slice from its element kinds and reports
`unclassified` for a shape still under construction that matches none of the four; checking
`translation`/`processor`/`automation`/`saga` kinds before `command`/`event` is what makes an
Automation or Translation slice classify correctly even though it also carries a command and
event of its own. See [cli.md](cli.md#em-export-file).)

| Pattern | Flow | DSL elements |
|---|---|---|
| State Change | UI → command → event | `ui`, `command`, `event` |
| State View | event(s) → read model → UI | `event`, `view from "…"`, `ui` |
| Automation | read model (slice before) → processor + command → event, together | `view`, then `processor` + `command` + `event` |
| Translation | boundary crossing → translation + command → event, together | [`view` (slice before)], then `translation` + `command` + `event` |

## State Change

A user submits a request; the system checks its invariants and records one or more events.
This is the only pattern that changes state, and it's where business rules live — a command
is rejected when a rule would be violated.

```em
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}
```

A command may record several events in one slice; the renderer draws a fan from the command
to each (never an event-to-event chain).

**Two intents record one fact.** `Create Product` and `Create Product Variant` can both end in
`Product Created`. Declare the event in each slice, bare, with the same name and context — the
repeats are one logical event (they inherit the first declaration's fields, tags and `public`),
each recording site feeds the nearest instance of the reading view at or after it (a repeated
`view … again` draws arrows only from the sites since its previous reading instance), and each site
needs a reader after it:

```em
slice "Create Product" {
  ui Product Form @Clerk
  command Create Product
  event Product Created @Catalog { productId: string, name: string }
}

slice "Products" {
  view Products from "Product Created" { productId: string, name: string }
  ui Product List @Clerk
}

slice "Create Variant" {
  ui Variant Form @Clerk
  command Create Product Variant
  event Product Created @Catalog      # bare repeat: same logical event
}

slice "Products with variants" {
  view Products again from "Product Created"
  ui Product List With Variants @Clerk
}
```

Both ends of the slice have to be joined up. Something must **trigger** the command — the `ui`
it's issued from, or (in the Automation and Translation patterns) the reaction that triggers
it, also in this slice; a command nothing points at is a write nobody can start. And the event
it records must end up in a **read model**; an event nothing projects is a write nobody can
see. A State Change slice is only finished once both hold, which in practice means pairing it
with the State View slice that consumes its event — and that State View needs its own consumer
in turn. [`em validate` warns](validation.md#both-ends-of-a-flow) on any of those gaps.

Name the command for the business intent, not the endpoint, and order State Change slices as one journey
per process rather than one create/update/archive block per entity: see
[The story, not the schema](storyline.md).

### One command, several outcomes: one slice

When a command can end in more than one outcome, the outcomes are **events of the same slice**,
not sibling slices per branch. Dilger's framing: a single business action has "two different
possible outcomes" — `PaymentIssued` or `PaymentFailed` — and both belong to the one command
that decided between them. The rejection rules, and the scenarios that show the command both
succeeding and not succeeding, are invariants and Given/When/Then scenarios in that slice's doc
(Dymitruk: "a few of these stories to show how a command can and cannot succeed" — write them as
scenarios first). If the failure then has its own continuation, Dilger's "Linearize it!" applies:
it becomes a *later* chapter linked to the originating event, never a parallel branch of the
same story.

```em
slice "Issue Payment" {
  ui Payout Screen @Finance
  command Issue Payment
  event Payment Issued | Payment Failed @Payment
}

slice "Payment Outcomes" {
  view Payment Outcomes from "Payment Issued", "Payment Failed"
  ui Payout History @Finance
}
```

The outcomes are written as alternatives (`event A | B @Ctx`) and share **one** context and one cell
in its lane: one command records exactly one of them. This is not the Law 1 fan from
[timeline.md](timeline.md), which is an atomic set of facts all recorded together on different
contexts. When the alternatives differ in fields or clauses, use the block form
(`oneof { event A @Ctx { ... } event B @Ctx { ... } }`); when an alternative is also recorded by
another command elsewhere, write it bare so it inherits the first declaration (see
[dsl.md](dsl.md#alternative-events--event-a--b-context)). Splitting this into an "Issue Payment" slice and a
"Payment Failed" slice is the anti-pattern; 1.18.0 adds the lint `automation-split-by-outcome`,
which flags the Automation form of it. See also [storyline.md](storyline.md).

## State View

Past events are projected into a read model that a screen displays. Read-only; nothing
changes.

```em
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
```

The `ui` is not optional decoration: a read model nothing displays is information projected out
of the system and then dropped. Every read model needs a consumer — a screen, a reaction that
watches it, or (in a headless model) the `ui` tagged to the API-caller persona.

When a read model keeps evolving as later events land, it reappears on the timeline with
`view <Name> again` rather than pulling arrows backward — see [timeline.md](timeline.md). **Each
instance is its own State View slice and needs its own consumer.** If you repeat a view next to
an event purely to keep the arrow short, bring its screen along; if there is nothing to bring,
the instance shouldn't be there.

A read model is one information need: it answers a question no existing view answers, and
it is repeated after every command that changes it so the reader sees the information arrive. See
[The story, not the schema](storyline.md#5-a-read-model-is-one-information-need).

## Automation

The system acts on its own. A processor watches a read model — a "to-do list" of pending
work — and issues a command when there's something to do. The reaction, the command it
triggers, and that command's event all share **one slice** — the same shape a `ui` already
uses in State Change. The read model it watches lives in the slice before, named by the
reaction's own `from`:

```em
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}

slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured @Payment
}

slice "Payments To Process — captured" {
  view Payments To Process again from "Payment Captured"
  ui Payments Queue @Ops
}
```

The processor never records an event itself, even though one now sits in its own slice — it
funnels its decision through the command, which is what actually records `Payment Captured`.
That's what keeps the command's invariants intact no matter who's calling it. A processor with
no command in its slice, and no explicit arrow to one elsewhere, is a validation warning: a
decision the system never acts on.

Name the read model after the pending work — `Payments To Process`, `Orders To Fulfill`,
`Pending Approvals` — never after the triggering event. The to-do list is a different thing
from the fact that feeds it: `Payment Requested` is what happened; `Payments To Process` is
what's left to do. Reusing the event's name isn't just harder to read — element names share
one namespace, so a view named `Payment Requested` collides with the event of the same name,
`from` references then resolve by element kind behind your back, and `em validate` flags the
duplicated name.

The reaction's own slice never holds a `ui` either — nothing on a screen triggers a processor
directly, only a read model does. A `ui` belongs in the slice that displays the read model
instead. A `ui` left in the reaction's slice renders disconnected, with no edge, and
`em validate` warns on it too.

The third slice is the State View that reads `Payment Captured` — here it's the same to-do
list, one payment shorter. Without it the event is unread and `em validate` warns.

### Outcomes of one reaction: one slice

A reaction that can succeed, fail, or schedule a retry is still **one** business reaction, so it
is one Automation slice. `Fulfilment Succeeded`, `Fulfilment Failed` and `Fulfilment Retry
Scheduled` are the *outcome events* of that slice's command (Dilger: "one business action… two
different possible outcomes"). The retry policy (how many attempts, what backoff) and the
failure handling (what happens at the limit) are **invariants and scenarios in that slice's
doc**, not new slices. Splitting the processor into a happy-path slice, a failure slice and a
retry slice along control flow is the anti-pattern — 1.18.0 adds the lint
`automation-split-by-outcome`, which flags it.

```em
slice "Pay Order" {
  ui Checkout @Customer
  command Pay Order
  event Order Paid @Order
}

slice "Orders To Fulfil" {
  view Orders To Fulfil from "Order Paid"
}

slice "Fulfil Order" {
  processor Fulfilment Worker from "Orders To Fulfil"
  command Fulfil Order
  event Fulfilment Succeeded | Fulfilment Failed | Fulfilment Retry Scheduled @Fulfilment
}

slice "Orders To Fulfil — retry" {
  view Orders To Fulfil again from "Fulfilment Retry Scheduled"
  ui Retry Queue @Ops
}

slice "Fulfilment Status" {
  view Fulfilment Status from "Fulfilment Succeeded", "Fulfilment Failed", "Fulfilment Retry Scheduled"
  ui Fulfilment Board @Ops
}
```

The retry fires because the processor's to-do list reads the retry-scheduled event: the view
reappears with `view Orders To Fulfil again from "Fulfilment Retry Scheduled"`, so the **same**
reaction picks the order up again. Add a new slice only when a **different actor or a different
trigger** is involved: a human override of a failed fulfilment, or a scheduled timer that is
itself modelled as a reaction on a different view, has its own trigger and so its own slice
(a slice that only retries another command is flagged by the lint `retry-slice-of`, 1.18.0).

The outcomes are alternatives on one context (`event A | B @Ctx`, see [dsl.md](dsl.md)): one run of
the command records exactly one of them, which is why a Law 1 fan across invented contexts is the
wrong picture. A failure that continues the story is "Linearized"
(Dilger) as a later chapter linked to the originating event, never a branch; that later chapter
reads the failure event through a view or a reaction, since Law 1 forbids event-to-event arrows. See
[storyline.md](storyline.md).

## Translation

An adapter carries data across a boundary — an external system, or another bounded context —
and translates it into the model's own language. A translation is a reaction just like a
processor: it triggers a command — in the same slice — and never records an event directly.

Two independent questions shape which form it takes — don't conflate them:

* **Trigger source** — does the input come from outside the model, or from the model's own
  state pushed back out?
* **Durable artifact** — is there a queryable, persisted thing behind the trigger (a queue,
  topic, or log), or is it an ephemeral call with nothing to query afterward?

The DSL only cares about the second question: a translation with a `from` reads a durable read
model from the slice before it; one without has no `from` at all, and nothing before it either.
Trigger source doesn't change the shape — an externally triggered translation backed by a real
queue is architecturally closer to the internally triggered case (same durability, same
queryability) than to a plain external call, even though both are "externally triggered."

Externally triggered, no durable artifact — the input comes from outside the model as a bare
call, so the translation has no `from` and nothing precedes it; the reaction, command, and
event share one slice with no earlier column at all:

```em
slice "Confirm Delivery" {
  translation Carrier Adapter
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}

slice "Deliveries" {
  view Deliveries from "Delivery Confirmed"
  ui Delivery Board @Ops
}
```

Externally triggered, durable artifact — a lot of real integrations persist the inbound message
first (for retries, ordering, audit) before processing it. Same read-model-in-the-slice-before
shape as the internal case below, just fed by an external fact instead of one the model
recorded itself:

```em
slice "Inbound Carrier Events" {
  view Inbound Carrier Events from "Carrier Event Received"
}

slice "Confirm Delivery" {
  translation Carrier Adapter from "Inbound Carrier Events"
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}

slice "Inbound Carrier Events — processed" {
  view Inbound Carrier Events again from "Delivery Confirmed"
  ui Delivery Board @Ops
}
```

`Carrier Event Received` is recorded by whatever ingest step persists the raw webhook payload —
out of frame here since this section is about the Translation pattern, not ingestion. That event
is a legitimate domain `event`, not a technical artifact dressed up as one, by the same test that
applies anywhere: an event is legitimate if it's scoped to the context/lane whose fact it
represents, not by who committed it. `Carrier Event Received @Shipping` (or a `Carrier` context
of its own) asserts a fact about the *carrier's* world — the same move as an Anti-Corruption-Layer
boundary event in DDD — and stays legitimate as long as it doesn't leak into the model's own
domain vocabulary.

Internally triggered — the system pushes its own state outward, so the translation reads a
read model from the slice before it:

```em
slice "Quotes To Sync" {
  view Accepted Quotes from "Quote Accepted"
}

slice "Record Sync" {
  translation CRM Sync from "Accepted Quotes"
  command Record Crm Sync
  event Quote Synced @Quote
}

slice "Accepted Quotes — synced" {
  view Accepted Quotes again from "Quote Synced"
  ui Sync Status @Customer
}
```

All three forms close with a State View slice, for the same reason as the Automation pattern:
the command's event needs a reader. Note that a reaction reading the view doesn't satisfy that —
reactions read read models, not events.

`em validate` warns when a reaction has no command in its own slice (and no explicit arrow to
one elsewhere) — a translation or processor wired straight to an event, with nothing issuing
it, is exactly what that check catches. Still route every reaction through a real command by
construction (`reaction → command → event`) rather than an explicit
`arrow "Reaction" -> "Event"` — that shape is its own
[connection-legality error](validation.md#connection-legality) (a reaction never records an
event itself). See [validation.md](validation.md).

### Calling an external system

Vendor integrations are the sharpest case of the one-slice rule. The translation reacts, issues
a command, and that command's event asserts a fact about what the *vendor* did — so the event's
`@Context` tag names the vendor, not the model's own domain, and the slice renders spanning from
the caller's own lane down into the vendor's row:

```em
context Vendor

slice "Translate Title" {
  translation Translation Service from "Titles To Translate"
  command Translate Title
  event Title Translated @Vendor
}
```

**This merged shape — translation, command, and vendor-tagged event sharing one slice — is
canonical for external-system calls.** It's tempting to split the reaction into its own slice
"for clarity," with the command and event following in the next one. That's syntactically
valid, but produces exactly the two warnings this pattern exists to avoid:

```
translation "Translation Service" triggers no command; add the command it issues (in this slice) or an explicit arrow to one
command "Translate Title" has nothing that triggers it; add the screen it is issued from (a `ui` in this slice) or the reaction that issues it (also in this slice)
```

An explicit `arrow` reconnecting the two slices silences both, but there's no reason to reach
for it here — one slice is simpler and warns about nothing to begin with.

## Headless systems

A headless system (no screens — clients call an API) still uses `ui` and `persona`. A slice is
trigger → command → event read vertically, so the trigger belongs *in* the slice, not split into
one of its own. Declare a persona per external caller/role and treat its `ui` boxes as API calls
instead of shipped screens — the same State Change and State View patterns above, no new shape:

```em
persona IntegratorAPI

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

`translation` stays reserved for genuine reactions and real external-system boundaries (the
Automation and Translation patterns above, unchanged) — not for modeling a synchronous
request/response API call. Internal-only commands and views with no public route carry no `ui`
at all; they follow the ordinary Automation pattern instead — the reaction shares the command's
slice, and an internal-only read model is consumed by that reaction (from the slice before), not
by a screen or an API query.
[examples/headless-api.em](../examples/headless-api.em) is a runnable model exercising all of
this: an API-triggered State Change and State View, a fully internal Automation (no `ui`), and a
Translation crossing a real external boundary. The
[em-with-ai repository](https://github.com/milehimikey/em-with-ai) is a larger worked example.
