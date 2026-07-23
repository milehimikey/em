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

## Law 2 — forward-only

Arrows never point right-to-left. Time flows one way, so a `from` source or an `arrow` that
would reach backward is a validation error, not a rendering choice.

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
  command Ship Order
  event Order Shipped @Order
}

slice "Track Fulfillment" {
  view Open Orders again from "Order Shipped"
  ui Order List @Customer
}
```

Instances declared with `again` are one logical read model. The first declaration owns the
`note` doc; each instance lists only the new events that reach it there; instances are
linked left-to-right with a continuity arrow; and a reaction (`processor … from "View"`)
reads the nearest instance at or before its own slice. Using `again` on a view with no
earlier declaration is an error — declare it plainly the first time.

Reactions obey the same law: a processor or translation may only read a view that already
exists on the timeline at its slice.
