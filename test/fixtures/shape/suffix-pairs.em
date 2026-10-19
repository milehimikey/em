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
slice "Fail Capture" {
  processor Gateway Failure from "Payments To Process"
  command Fail Payment Capture
  event Payment Capture Failed
}
slice "Authorize Payment" {
  processor Authorizer from "Payments To Process"
  command Authorize Payment
  event Payment Authorized
}
slice "Fail Authorization" {
  processor Authorizer Failure from "Payments To Process"
  command Fail Payment Authorization
  event Payment Authorization Failed
}
slice "Place Order" {
  processor Placer from "Payments To Process"
  command Place Order
  event Order Placed
}
slice "Fail Placement" {
  processor Placer Failure from "Payments To Process"
  command Fail Order Placement
  event Order Placement Failed
}
slice "Ship Order" {
  processor Shipper from "Payments To Process"
  command Ship Order
  event Order Shipped
}
slice "Fail Shipment" {
  processor Shipper Failure from "Payments To Process"
  command Fail Order Shipment
  event Order Shipment Failed
}
slice "Charge Customer Card" {
  processor Charger from "Payments To Process"
  command Charge Customer Card
  event Customer Card Charge Succeeded
}
slice "Reject Customer Card" {
  processor Fraud Check from "Payments To Process"
  command Reject Customer Card
  event Customer Card Charge Rejected
}
slice "Pack Order Item" {
  processor Packer from "Payments To Process"
  command Pack Order Item
  event Order Item Packed
}
slice "Refuse Order Item" {
  processor QA from "Payments To Process"
  command Refuse Order Item
  event Order Item Rejected
}
slice "One" {
  translation PIM Push from "Payments To Process"
  command Sync Product To PIM
  event Product Sync Succeeded
}
slice "Two" {
  translation PIM Push Failure from "Payments To Process"
  command Record Product Sync Failure
  event Product Sync Failed
}
slice "Alt" {
  processor Alt from "Payments To Process"
  command Settle Payment
  event Payment Settled | Payment Settlement Failed
}
