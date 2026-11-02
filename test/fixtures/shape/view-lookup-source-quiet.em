model "Quiet Lookups (mini)"

persona Member

context Account
context Billing

slice "Open Account" {
  ui Open Account Form @Member
  command Open Account
  event Account Opened @Account { accountId: UUID, ownerName: String }
}

slice "Account Summary" {
  view Account Summary from "Account Opened"
  ui Summary Screen @Member
}

slice "Update Billing Address" {
  ui Billing Form @Member
  command Update Billing Address
  event Billing Address Updated @Billing { accountId: UUID, address: String }
}

slice "Account Summary with Billing" {
  view Account Summary again from "Billing Address Updated"
  ui Summary Screen @Member
}

slice "Close Account" {
  ui Close Account Form @Member
  command Close Account
  event Account Closed @Account
}

slice "Account History" {
  view Account History from "Account Opened", "Account Closed"
  ui History Screen @Member
}
