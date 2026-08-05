# Paired with glossary-b.em to exercise `em glossary`'s cross-model conflict
# checks: "Order Confirmed" is an *event* here but a *view* in glossary-b.em
# (kind-conflict), and the shared "total" field is typed `Money` here but
# `number` there (field-type-conflict). See docs/cli.md's `em glossary` section.
model "Checkout"

persona Customer
context Sales

slice "Submit Order" {
  ui Checkout Screen @Customer
  command Submit Order
  event Order Confirmed @Sales { total: Money }
}

slice "Review Order" {
  view Order Summary from "Order Confirmed" { total: Money }
  ui Order Review @Customer
}
