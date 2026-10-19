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
  event Payment Capture Succeeded | Payment Capture Failed
}
slice "Ledger" {
  view Ledger from "Payment Capture Succeeded", "Payment Capture Failed"
  ui Ledger Screen @Ops
}
slice "Payments To Process — direct" {
  processor Direct Gateway from "Payment Requested"
  command Capture Payment Directly
  event Payment Capture Expired
}
