model "Renames"

# Demonstrates MIL-68's `renamed from` syntax: event/command rename metadata for payload
# conversion at codegen time. `em diff` deliberately does not read this clause — a rename
# still reports as a plain remove+add; this is codegen/export metadata only.

persona Billing Admin

context Billing

slice "Record Payment" {
  ui Payment Entry @Billing Admin
  # Element-level renamed-from on a command, plus a field-level one on a field that also
  # changed shape/name at the same time.
  command RecordPayment renamed from "SubmitPayment" {
    orderId: UUID
    amountCents: long renamed from "amount"
  }
  # Same idea on the recorded event: the event itself was renamed once, and one of its
  # fields was renamed too.
  event PaymentRecorded renamed from "PaymentRegistered" @Billing {
    orderId: UUID
    amountCents: long renamed from "amount"
  }
}

slice "View Payments" {
  view Payments { orderId: UUID, amountCents: long } from "PaymentRecorded"
  ui Payment List @Billing Admin
}
