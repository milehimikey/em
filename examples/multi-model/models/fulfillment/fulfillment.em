model "Fulfillment" owner "Warehouse team"

persona Warehouse

context Order

slice "Receive Order" {
  # checkout:event.order-submitted — A submitted order is handed to the warehouse to be fulfilled.
  translation Order Intake consumes checkout:event.order-submitted
  command Accept Order
  event Order Accepted @Order
}

slice "Orders To Fulfil" {
  view Orders To Fulfil from "Order Accepted"
  ui Fulfilment Board @Warehouse
}

slice "Checkout" {
  ui Return Screen @Warehouse
  command Process Return
  event Return Processed @Order
}

slice "Return Confirmation" {
  view Return Confirmation from "Return Processed"
  ui Confirmation Screen @Warehouse
}
