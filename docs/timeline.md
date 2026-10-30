# The Two Laws of the Timeline

An event model reads like a story: left to right, one slice at a time. Two laws keep it
readable that way, and `em validate` enforces both. They're grounded in Event Modeling
canon — Dymitruk's eventmodeling.org, and Dilger's *Understanding Eventsourcing* ("always
readable left to right").

## Law 1 — no event→event connections

Information moves only via the [four patterns](patterns.md): into the system through a
command, out through a read model. Events never point at other events; an event chain would
hide the command (and its invariants) that actually produced each fact.

A command may still record multiple events in one slice — an atomic multi-stream fact set.
The renderer draws a fan from the command to each event, side-routing the fanned arrows so
they can never be misread as a chain:

```em
slice "Close Account" {
  command Close Account
  event Account Closed @Account
  event Final Statement Issued @Billing
}
```

Alternatives are a fan too, not a chain. When the events are *outcomes of one decision* — the command
records **one of** them — write `event A | B @Context`: the alternatives share one box with an *or* marker and
the command has one arrow, still never event to event.

```em
slice "Create External ID" {
  command CreateExternalId
  event ProductExternalIdCreated | VariantExternalIdCreated @Product
}
```

## Law 2 — forward-only

Arrows never point right-to-left. Time flows one way, so a `from` source or an `arrow` that
would reach backward is a validation error, not a rendering choice.

File order is the timeline. The one extension is a storyline's `after "<other>"` clause
([dsl.md](dsl.md#after-storyline--a-storys-own-timeline), GH #277): a secondary storyline can declare which
story it follows, and its slices are then read as if they came after that storyline's last slice — Law 2 is a
rule about the *story*, so the story's own order is what the forward-only checks use. A backward feed into
the referenced storyline, or an `after` cycle, is still an error.

The interesting case is a read model that keeps evolving. Suppose Open Orders should also
reflect shipments, and shipping happens after the view first appears:

```em
slice "Place Order" {
  ui Checkout @Customer
  command Place Order
  event Order Placed @Order
}

slice "View Open Orders" {
  view Open Orders from "Order Placed", "Order Shipped"   # error: Order Shipped is later
  ui Order List @Customer
}

slice "Ship Order" {
  ui Shipping Desk @Ops
  command Ship Order
  event Order Shipped @Order
}
```

```
error:12 time flows left to right: event "Order Shipped" (slice 3) happens after
         read model "Open Orders" (slice 2); move this source to a later
         `view Open Orders again` instance
```

The fix is the `again` device: the view reappears on the timeline at the point where the
new event lands, instead of pulling an arrow backward:

```em
slice "View Open Orders" {
  view Open Orders from "Order Placed"
  ui Order List @Customer
}

slice "Ship Order" {
  ui Shipping Desk @Ops
  command Ship Order
  event Order Shipped @Order
}

slice "Track Fulfillment" {
  view Open Orders again from "Order Shipped"
  ui Order List @Customer
}
```

Instances declared with `again` are one logical read model. The first declaration owns the
`note` doc; each instance lists only the new events that reach it there; and a reaction
(`processor … from "View"`) reads the nearest instance at or before its own slice. Using
`again` on a view with no earlier declaration is an error — declare it plainly the first
time.

Repeating a view after every command that feeds it needs no ceremony (GH #287). Write the line in
the command's own slice and `em` lifts it into a continuation column right after it, named and
keyed for you; the same slice may carry as many `again` lines as the command feeds views:

```em
slice "Ship Order" {
  ui Shipping Desk @Ops
  command Ship Order
  event Order Shipped @Order
  view Open Orders again from "Order Shipped" shown on "Order List"
}
```

renders the same as a hand-written continuation slice after "Ship Order". The synthesized column (one per host slice, all its lifted lines stacked)
has the stable key `ship-order--again`, is a continuation of the view's first slice, and
is not listed by `em slice index`. A hand-written continuation slice may hold several `again`
views (they stack in the `api` cell) and may omit its name (auto-named `"Open Orders View: Order
Shipped"`). See [dsl.md](dsl.md#view--again).

Instances are **never** connected to one another. Repeating a view is an ergonomic device
for showing the same read model at successive points in time: the continuity is implied by
the shared name, and the events arriving at each instance are what show how the view
changes. An arrow between two instances would say the read model feeds itself, and because
commands and read models share the API lane, it would also be drawn straight through any
command between them — reading as an illegal command → read model connection. Writing one by
hand is a [validation error](validation.md#connection-legality);
[examples/timeline-rules.em](../examples/timeline-rules.em) shows how the repeat is meant to
look.

Reactions obey the same law: a processor or translation may only read a view that already
exists on the timeline at its slice.

### One event recorded in several slices

When two commands record the same event (same name, same context — see
[dsl.md](dsl.md#one-event-recorded-by-several-commands)), each recording site is a separate
box on the timeline and the same forward rule applies to each: a read model only reads a
recording at or before its own slice, and every recording site needs a reader at or after it.
Each site feeds the nearest instance of the reading view at or after it: a `view V again` draws
arrows only from the sites recorded since the previous instance of V that also reads the event.
A site placed after the last reader warns `event-unread`; add `view V again from "Event"` after it.
