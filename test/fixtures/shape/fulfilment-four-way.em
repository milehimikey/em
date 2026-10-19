slice "Orders To Fulfil" {
  view Orders To Fulfil from "Order Placed"
}
slice "Fulfil Order" {
  processor Fulfiller from "Orders To Fulfil"
  command Fulfil Order
  event Order Fulfilled
}
slice "Fail Fulfilment" {
  processor Fulfil Failure from "Orders To Fulfil"
  command Fail Order Fulfilment
  event Order Fulfilment Failed
}
slice "Retry Fulfilment" {
  processor Fulfil Retry from "Orders To Fulfil"
  command Retry Fulfil Order
  event Order Fulfilment Retried
}
slice "Time Out Fulfilment" {
  processor Fulfil Timeout from "Orders To Fulfil"
  command Time Out Order Fulfilment
  event Order Fulfilment Timed Out
}
