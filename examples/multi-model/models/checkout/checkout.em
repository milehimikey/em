model "Checkout" owner "Storefront team"

persona Customer

context Order

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order {
    total: decimal
    note?: text
  }
  event Order Submitted @Order public {
    orderId: uuid assigned
    total: decimal
    placedAt: datetime assigned
    note?: text
  }
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
