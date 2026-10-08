model "Fulfillment" owner "@example/warehouse"

persona Warehouse

context Order

slice "Receive Order" {
  # checkout:event.order-submitted — A submitted order is handed to the warehouse to be fulfilled.
  translation Order Intake consumes checkout:event.order-submitted {
    orderId: uuid
    total: decimal
  }
  command Accept Order public {
    orderId: uuid
    total: decimal
  }
  invariant INV-FUL-1 "An order is accepted at most once per checkout order id"
  event Order Accepted @Order {
    orderId: uuid
    total: decimal
    acceptedAt: datetime assigned
  }
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
