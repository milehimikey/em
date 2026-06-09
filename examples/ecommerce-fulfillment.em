model "E-Commerce Fulfillment"

persona Shopper
persona Picker
persona Manager
persona Support

context Cart
context Order
context Payment
context Shipping

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
  command Place Order
  event Order Placed @Order
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

# --- Automation: settle queued payments ---
slice "Payments To Settle" {
  view Payments To Settle from "Payment Requested"
  processor Payment Gateway
}

# --- Command (triggered): capture ---
slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}

# --- Automation: fulfill paid orders ---
slice "Fulfillment Queue" {
  view Orders To Fulfill from "Payment Captured"
  processor Fulfillment Engine
}

# --- Command (triggered): reserve stock ---
slice "Reserve Stock" {
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

# --- Automation: dispatch picked shipments ---
slice "Dispatch Queue" {
  view Shipments To Dispatch from "Items Picked"
  processor Dispatch Service
}

# --- Command (triggered): dispatch ---
slice "Dispatch Shipment" {
  command Dispatch Shipment
  event Shipment Dispatched @Shipping
}

# --- Translation: external carrier tracking feed ---
slice "Carrier Sync" {
  view Carrier Tracking from "Shipment Dispatched"
  translation Carrier Adapter
}

# --- Command (triggered): record delivery ---
slice "Record Delivery" {
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
