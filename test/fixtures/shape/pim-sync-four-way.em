slice "Products To Sync" {
  view Products To Sync from "Product Changed"
}
slice "Sync OK" {
  processor PIM Sync from "Products To Sync"
  command Sync Product To PIM
  event Product Sync Succeeded
}
slice "Sync Failed" {
  processor PIM Sync Failure from "Products To Sync"
  command Record Product Sync Failure
  event Product Sync Failed
}
slice "Sync Retry" {
  processor PIM Sync Retry from "Products To Sync"
  command Retry Sync Product To PIM
  event Product Sync Retried
}
slice "Sync Timeout" {
  processor PIM Sync Timeout from "Products To Sync"
  command Expire Product Sync
  event Product Sync Timed Out
}
