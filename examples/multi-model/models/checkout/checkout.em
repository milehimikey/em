model "Checkout"

persona Customer

context Order

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order
  event Order Submitted @Order public
}

slice "Order Confirmation" {
  view Order Confirmation from "Order Submitted"
  ui Confirmation Screen @Customer
}

slice "Cancel Order" {
  ui Order Details @Customer
  command Cancel Order
  event Order Cancelled @Order public
}
