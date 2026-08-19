model "E-Commerce Fulfillment"

persona Shopper
persona Picker
persona Manager
persona Support

context Cart
context Order
context Payment
context Shipping

# A named type (MIL-64): declared once, referenced below as an array (`OrderLine[]`) from
# both the command that accepts it and the event that records it.
type OrderLine {
  productId: UUID
  quantity: int
  unitPrice: Money
}

# --- Input: browse + add to cart ---
slice "Browse Catalog" {
  ui Product Catalog @Shopper
  command Add To Cart
  event Item Added @Cart
}

# --- Output: cart view ---
slice "View Cart" {
  view Cart Contents from "Item Added"
  ui Cart Page @Shopper
}

# --- Input: checkout ---
slice "Checkout" {
  ui Checkout Form @Shopper
  command Place Order {
    customerId: UUID
    lines: OrderLine[]
  }
  event Order Placed @Order {
    lines: OrderLine[]
  }
}

# --- Output: order confirmation ---
slice "Order Confirmation" {
  view Order Summary from "Order Placed"
  ui Confirmation Page @Shopper
}

# --- Input: request payment ---
slice "Request Payment" {
  ui Payment Form @Shopper
  command Submit Payment
  event Payment Requested @Payment
}

# --- Read model the payment automation watches ---
slice "Payments To Settle" {
  view Payments To Settle from "Payment Requested"
}

# --- Automation: settle queued payments (reaction + command + event together) ---
slice "Capture Payment" {
  processor Payment Gateway from "Payments To Settle"
  command Capture Payment
  event Payment Captured @Payment
}

# --- Read model the fulfillment automation watches ---
slice "Fulfillment Queue" {
  view Orders To Fulfill from "Payment Captured"
}

# --- Automation: fulfill paid orders (reaction + command + event together) ---
slice "Reserve Stock" {
  processor Fulfillment Engine from "Orders To Fulfill"
  command Reserve Stock
  event Stock Reserved @Shipping
}

# --- Output: picking list for the warehouse ---
slice "Pick List" {
  view Pick List from "Stock Reserved"
  ui Pick List Screen @Picker
}

# --- Input: picker confirms the pick ---
slice "Confirm Pick" {
  ui Scan Items @Picker
  command Confirm Pick
  event Items Picked @Shipping
}

# --- Read model the dispatch automation watches ---
slice "Dispatch Queue" {
  view Shipments To Dispatch from "Items Picked"
}

# --- Automation: dispatch picked shipments (reaction + command + event together) ---
slice "Dispatch Shipment" {
  processor Dispatch Service from "Shipments To Dispatch"
  command Dispatch Shipment
  event Shipment Dispatched @Shipping
}

# --- Read model the carrier translation watches ---
slice "Carrier Sync" {
  view Carrier Tracking from "Shipment Dispatched"
}

# --- Translation: external carrier tracking feed (reaction + command + event together) ---
slice "Record Delivery" {
  translation Carrier Adapter from "Carrier Tracking"
  command Record Delivery
  event Order Delivered @Shipping
}

# --- Output: shopper order tracking ---
slice "Track Order" {
  view Delivery Status from "Order Delivered"
  ui Order Tracking @Shopper
}

# --- Output: manager dashboard (multi-source read model) ---
slice "Ops Dashboard" {
  view Fulfillment Board from "Stock Reserved", "Shipment Dispatched"
  ui Ops Console @Manager
}

# --- Output: support lookup ---
slice "Support Lookup" {
  view Order History from "Order Delivered"
  ui Support Console @Support
}
