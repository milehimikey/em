model "Fulfillment"

persona Warehouse

context Order

slice "Checkout" {
  ui Return Screen @Warehouse
  command Process Return
  event Return Processed @Order
}

slice "Return Confirmation" {
  view Return Confirmation from "Return Processed"
  ui Confirmation Screen @Warehouse
}
