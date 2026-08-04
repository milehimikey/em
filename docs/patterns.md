# The four patterns

Event Modeling builds every system from four patterns, and every slice in a `.em` model is
exactly one of them. The discipline behind the patterns: information moves **into** the
system through a command that records an event, **out of** the system through a read model,
and no other way. Automations and translations are not exceptions — they are reactions that
issue a command, which then records the event.

| Pattern | Flow | DSL elements |
|---|---|---|
| State Change | UI → command → event | `ui`, `command`, `event` |
| State View | event(s) → read model → UI | `event`, `view from "…"`, `ui` |
| Automation | read model → processor, then command → event | `view` + `processor`, next slice `command` + `event` |
| Translation | boundary crossing → translation, then command → event | `translation` [+ `view`], next slice `command` + `event` |

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

Both ends of the slice have to be joined up. Something must **trigger** the command — the `ui`
it's issued from, or (in the Automation and Translation patterns) the reaction in the slice
before it; a command nothing points at is a write nobody can start. And the event it records
must end up in a **read model**; an event nothing projects is a write nobody can see. A State
Change slice is only finished once both hold, which in practice means pairing it with the State
View slice that consumes its event — and that State View needs its own consumer in turn.
[`em validate` warns](validation.md#both-ends-of-a-flow) on any of those gaps.

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

## Automation

The system acts on its own. A processor watches a read model — a "to-do list" of pending
work — and issues a command when there's something to do. The pattern is always **two
slices**: the reaction slice holds only the read model and the processor; the command it
triggers, and that command's event, form the next slice.

```em
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}

slice "Payments To Process — captured" {
  view Payments To Process again from "Payment Captured"
  ui Payments Queue @Ops
}
```

Why two slices? Because the processor never records an event itself. It funnels its decision
through a command like everyone else, so the command slice keeps its invariants no matter
who's calling. Putting the command in the reaction's slice draws a validation warning.

The third slice is the State View that reads `Payment Captured` — here it's the same to-do
list, one payment shorter. Without it the event is unread and `em validate` warns.

## Translation

An adapter carries data across a boundary — an external system, or another bounded context —
and translates it into the model's own language. A translation is a reaction just like a
processor: it triggers a command and never records an event directly. Two trigger forms:

Externally triggered — the input comes from outside the model, so the translation has no
`from`:

```em
slice "Carrier Webhook" {
  translation Carrier Adapter
}

slice "Confirm Delivery" {
  command Confirm Delivery
  event Delivery Confirmed @Shipping
}

slice "Deliveries" {
  view Deliveries from "Delivery Confirmed"
  ui Delivery Board @Ops
}
```

Internally triggered — the system pushes its own state outward, so the translation reads a
read model:

```em
slice "Quotes To Sync" {
  view Accepted Quotes from "Quote Accepted"
  translation CRM Sync
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

Both forms close with a State View slice, for the same reason as the Automation pattern: the
command's event needs a reader. Note that a reaction reading the view doesn't satisfy that —
reactions read read models, not events.

Note that `em validate` warns when a reaction shares a slice with a command, but cannot
catch a reaction wired straight to an event — keep the two-slice split by construction
(see [validation.md](validation.md)).

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
at all; they follow the ordinary Automation pattern instead.
[examples/headless-api.em](../examples/headless-api.em) is a runnable model exercising all of
this: an API-triggered State Change and State View, a fully internal Automation (no `ui`), and a
Translation crossing a real external boundary. The
[em-with-ai repository](https://github.com/milehimikey/em-with-ai) is a larger worked example.
