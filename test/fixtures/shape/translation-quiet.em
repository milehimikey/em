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
slice "Fail Payment" {
  translation Gateway Failure from "Payment Requested"
  command Fail Payment Capture
  event Payment Capture Failed
  event Payment Capture Succeeded
}
slice "Ledger" {
  view Ledger from "Payment Captured", "Payment Capture Failed", "Payment Capture Succeeded"
}
