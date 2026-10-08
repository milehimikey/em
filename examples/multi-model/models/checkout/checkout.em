model "Checkout" owner "@example/storefront"

persona Customer

context Order

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order public {
    total: decimal
    note?: text
  }
  invariant INV-CHK-1 "An order is submitted with a positive total"
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
  invariant INV-CXL-1 "Only an order that has not shipped can be cancelled"
  event Order Cancelled @Order public
}
