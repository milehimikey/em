model "Order Fulfillment"

persona Customer
persona Manager

context Order
context Payment

# --- Command pattern: UI -> command -> event ---
# `source` (optional, slice-level only) links a slice back to the ticket/conversation it
# traces to — machine-traversable via `em export`'s `model.slices[].source` (MIL-69).
slice "Browse Catalog" source "https://linear.app/team/issue/MIL-60" {
  ui Product Catalog @Customer
  command Place Order note "slices/browse-catalog.md" {
    customerId
    items: List<LineItem>
    total: Money
  }
  event Order Placed @Order note "notes/order-placed.md" {
    orderId assigned
    customerId
    total: Money
    placedAt: Instant assigned
  }
}

# --- View pattern: event -> read model -> UI ---
slice "View Open Orders" {
  view Open Orders from "Order Placed" note "slices/view-open-orders.md" {
    orderId
    total: Money
    status
  }
  ui Order List @Customer
}

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Payment note "slices/checkout.md" {
    orderId
    amount: Money
  }
  event Payment Requested @Payment {
    orderId
    amount: Money
  }
}

# --- View pattern: a human view of pending payments ---
slice "Manager Review" {
  view Pending Payments from "Payment Requested"
  ui Payment Dashboard @Manager
}

# --- Read model the automation watches, in its own slice ---
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}

# --- Automation slice: the processor, the command it triggers, and that command's event ---
slice "Capture Payment" {
  processor Payment Gateway from "Payments To Process" note "slices/capture-payment.md"
  command Capture Payment note "notes/capture-payment.md" {
    authorizationId
    amount: Money
  }
  event Payment Captured @Payment {
    orderId assigned
    amount: Money
    capturedAt: Instant assigned
  }
}

# --- View pattern: receipt ---
slice "Show Receipt" {
  view Receipts from "Payment Captured"
  ui Receipt Screen @Customer
}
