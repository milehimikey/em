slice "Request Payment" {
  ui Checkout @Shopper
  command Request Payment
  event Payment Requested
}
slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
}
slice "Capture Payment" {
  processor Gateway from "Payments To Process"
  command Capture Payment
  event Payment Captured
}
slice "Notify Ledger" {
  translation Ledger Push from "Payments To Process"
  command Notify Ledger Gateway
  event Ledger Notified
}
slice "Ledger" {
  view Ledger from "Payment Captured", "Ledger Notified"
  ui Ledger Screen @Ops
}
