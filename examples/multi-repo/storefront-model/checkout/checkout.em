model "Checkout" owner "@example/storefront"

slice "Place Order" {
  ui Checkout @Customer
  command Place Order {
    orderId: uuid
    total: decimal
  }
  event Order Placed @Orders public {
    orderId: uuid
    total: decimal
  }
}

slice "Orders To Charge" {
  view Orders To Charge from "Order Placed"
  ui Charge Queue @Staff
}

slice "Take Payment" {
  processor Charge Card from "Orders To Charge"
  command Take Payment {
    orderId: uuid
  }
  event Payment Taken @Payments {
    orderId: uuid
  }
}

slice "Charged Orders" {
  view Orders To Charge again from "Payment Taken"
  ui Payments Board @Staff
}
