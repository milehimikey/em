model "Order Fulfillment"

persona Customer
persona Manager

context Order
context Payment

# --- Command pattern: UI -> command -> event ---
slice "Browse Catalog" {
  ui Product Catalog @Customer
  command Place Order {
    customerId
    items: List<LineItem>
    total: Money
  }
  event Order Placed @Order note "notes/order-placed.md" {
    orderId
    customerId
    total: Money
    placedAt: Instant
  }
}

# --- View pattern: event -> read model -> UI ---
slice "View Open Orders" {
  view Open Orders from "Order Placed" {
    orderId
    total: Money
    status
  }
  ui Order List @Customer
}

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Payment
  event Payment Requested @Payment
}

# --- View pattern: a human view of pending payments ---
slice "Manager Review" {
  view Pending Payments from "Payment Requested"
  ui Payment Dashboard @Manager
}

# --- Automation slice: only the read model it reads + the processor ---
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

# --- Command slice: the command the automation triggers + its event ---
slice "Capture Payment" {
  command Capture Payment note "notes/capture-payment.md" {
    authorizationId
    amount: Money
  }
  event Payment Captured @Payment {
    orderId
    amount: Money
    capturedAt: Instant
  }
}

# --- View pattern: receipt ---
slice "Show Receipt" {
  view Receipts from "Payment Captured"
  ui Receipt Screen @Customer
}
