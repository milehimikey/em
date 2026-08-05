model "Clauses After Fields"

# A small model whose only job is to prove that `note`, `issue`, `divergence`,
# `from`, `@Tag`, and `again` all parse correctly when written AFTER an inline
# `{ fields }` block, not just before it — the bug fixed by MIL-65/MIL-74.
# Every clause below trails a fields block; compare order-fulfillment.em,
# which places the same clauses BEFORE the fields block. Both orders are
# valid and render identically — that's the point.

persona Customer

context Order

slice "Place Order" {
  ui Checkout @Customer
  command Place Order { customerId, items: List<LineItem> } issue "who validates the discount code?"
  event Order Placed { orderId, customerId, total: Money } @Order note "notes/clauses-after-fields.md"
}

slice "View Open Orders" {
  view Open Orders { orderId, total: Money, status } from "Order Placed"
  ui Order List @Customer
}

slice "Cancel Order" {
  ui Cancel Order @Customer
  command Cancel Order { orderId } issue "does this allow partial cancellation?"
  event Order Cancelled { orderId } @Order
}

# `again` trailing the fields block, same as `from` above — a later instance
# of the read model declared purely with trailing clauses. `divergence` trails
# too, proving it parses in the same trailing position as `issue`/`note`.
slice "View Open Orders — cancelled" {
  view Open Orders { orderId, total: Money, status } again from "Order Cancelled" divergence "cancelled orders stay in the same projection rather than a separate 'Cancelled Orders' view — status field already distinguishes them"
  ui Order List @Customer
}
