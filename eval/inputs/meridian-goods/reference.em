model "Meridian Goods — Ordering"

persona Customer
persona Staff
context Ordering
context Payments

type OrderLine {
  sku: String
  quantity: Int
  priceCents: Int
}

slice "Place Order" {                      # State Change
  ui Storefront @Customer
  command Place Order {
    orderId: UUID
    customerId: UUID
    lineItems: OrderLine[]
    totalCents: Int
    placedAt: DateTime
  }
  event Order Placed @Ordering {
    orderId: UUID
    customerId: UUID
    lineItems: OrderLine[]
    totalCents: Int
    placedAt: DateTime
  }
}

slice "Payments To Request" {              # Automation's read model (consumed by next slice's processor)
  view Payments To Request from "Order Placed" {
    orderId: UUID
    totalCents: Int
    placedAt: DateTime
  }
}

slice "Request Payment" {                  # Automation: reaction + command + event together
  processor Payment Requester from "Payments To Request"
  command Request Payment {
    paymentId: UUID
    orderId: UUID
    amountCents: Int
    requestedAt: DateTime
  }
  event Payment Requested @Payments {
    paymentId: UUID
    orderId: UUID
    amountCents: Int
    requestedAt: DateTime
  }
}

slice "Record Payment Result" {            # Translation: provider webhook, externally triggered, one slice
  translation Payment Provider Adapter
  command Record Payment Result {
    paymentId: UUID
    orderId: UUID
    amountCents: Int
    capturedAt: DateTime
    providerRef: String
  }
  event Payment Captured @Payments {
    paymentId: UUID
    orderId: UUID
    amountCents: Int
    capturedAt: DateTime
    providerRef: String
  }
}

slice "Open Orders" {                      # State View — staff-facing
  view Open Orders from "Order Placed", "Payment Captured" {
    orderId: UUID
    customerId: UUID
    totalCents: Int
    placedAt: DateTime
    capturedAt: DateTime
  }
  ui Fulfillment Dashboard @Staff
}

slice "Order Status" {                     # State View — customer-facing, closes all loops
  view Order Status from "Order Placed", "Payment Requested", "Payment Captured" {
    orderId: UUID
    placedAt: DateTime
    requestedAt: DateTime
    capturedAt: DateTime
  }
  ui Account Page @Customer
}

slice "Cancel Order" {                     # State Change — CHANGE beat: customers self-serve cancellation
  ui Account Page @Customer
  command Cancel Order {
    orderId: UUID
    customerId: UUID
    cancelledAt: DateTime
  }
  event Order Cancelled @Ordering {
    orderId: UUID
    customerId: UUID
    cancelledAt: DateTime
  }
}

slice "Open Orders — cancelled" {          # State View — repeated view instance, does NOT connect to the earlier Open Orders
  view Open Orders again from "Order Cancelled" {
    orderId: UUID
    customerId: UUID
    cancelledAt: DateTime
  }
  ui Fulfillment Dashboard @Staff
}
