# Paired with glossary-a.em to exercise `em glossary`'s cross-model conflict
# checks: "Order Confirmed" is a *view* here but an *event* in glossary-a.em
# (kind-conflict), and the shared "total" field is typed `number` here but
# `Money` there (field-type-conflict). See docs/cli.md's `em glossary` section.
model "Billing"

persona Analyst
context Finance

slice "Show Invoice" {
  event Invoice Issued @Finance
}

slice "Confirm Invoice" {
  view Order Confirmed from "Invoice Issued" { total: number }
  ui Invoice Review @Analyst
}
