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

## State View

Past events are projected into a read model that a screen displays. Read-only; nothing
changes.

```em
slice "Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}
```

When a read model keeps evolving as later events land, it reappears on the timeline with
`view <Name> again` rather than pulling arrows backward — see [timeline.md](timeline.md).

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
```

Why two slices? Because the processor never records an event itself. It funnels its decision
through a command like everyone else, so the command slice keeps its invariants no matter
who's calling. Putting the command in the reaction's slice draws a validation warning.

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
```

Note that `em validate` warns when a reaction shares a slice with a command, but cannot
catch a reaction wired straight to an event — keep the two-slice split by construction
(see [validation.md](validation.md)).

## Headless systems

When there is no UI — clients call an API — drop `ui` and `persona` entirely. Writes become
`translation → command → event`, with the inbound translation named for the caller. Reads
become `read model → translation`, where the read translation is the API query: it returns
data outbound and triggers no command, making it the headless analog of `view → ui`, not a
reaction. The [em-with-ai repository](https://github.com/milehimikey/em-with-ai) is a full
worked example of a headless model.
