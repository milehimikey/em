# Note: `Order Placed`

The corner marker on this event links here. Notes live in markdown so the
diagram stays uncluttered — click the marker in the SVG to open this file.

## What it records

`Order Placed` is the event written when a shopper confirms an order from the
product catalog. It is the source of truth the **Open Orders** read model is
projected from (`view Open Orders from "Order Placed"`).

## Open questions

- Should a placed order reserve stock immediately, or only on payment capture?
- Does an order placed with an out-of-stock item still emit this event, or a
  separate `Order Rejected`?

## Fields (coming in a later phase)

In the upcoming fields syntax this event will carry its data attributes
(e.g. `orderId`, `customerId`, `total`), which the slicing/information-
completeness checks will trace through to the read models and screens that
display them.
