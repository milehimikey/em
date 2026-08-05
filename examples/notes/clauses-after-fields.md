# Note: `Order Placed`

The corner marker on this event links here — same mechanism as
`order-fulfillment.em`'s note, except here the `note "..."` clause is written
*after* the event's `{ fields }` block instead of before it:

```em
event Order Placed { orderId, customerId, total: Money } @Order note "notes/clauses-after-fields.md"
```

Prior to the MIL-65/MIL-74 fix, a clause written in this position was silently
dropped during parsing — `em export` would show `"note": null"` with no
parse error or `em validate` warning to catch it. This file existing, and the
marker linking to it in the rendered diagram, is the proof the clause was
captured.
