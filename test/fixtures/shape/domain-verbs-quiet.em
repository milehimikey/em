slice "Place Order" {
  ui Checkout @Shopper
  command Place Order
  event Order Placed
  event Payment Received
}
slice "Orders Awaiting Payment" {
  view Orders Awaiting Payment from "Order Placed", "Payment Received"
}
slice "Cancel Unpaid Order" {
  processor Payment Deadline from "Orders Awaiting Payment"
  command Cancel Order
  event Order Cancelled
}
slice "Complete Paid Order" {
  processor Payment Watcher from "Orders Awaiting Payment"
  command Complete Order
  event Order Completed
}
slice "Ship Order" {
  translation Carrier Push from "Orders Awaiting Payment"
  command Ship Order
  event Order Shipped
}
slice "Order History" {
  view Order History from "Order Cancelled", "Order Completed", "Order Shipped"
}
