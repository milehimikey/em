model "Checkout"

persona Customer

context Order

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order
  event Order Submitted @Order
}

slice "Order Confirmation" {
  view Order Confirmation from "Order Submitted"
  ui Confirmation Screen @Customer
}
