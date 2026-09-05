model "Fulfillment"

persona Warehouse

context Order

slice "Receive Order" {
  translation Order Intake
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
