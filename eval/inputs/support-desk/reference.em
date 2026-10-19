model "Support Desk"

persona Customer
persona Agent
context Tickets
context Escalations

slice "Open Ticket" {
  ui Help Form @Customer
  command Open Ticket { ticketId: UUID, customerId: UUID, subject: String, openedAt: DateTime }
  event Ticket Opened @Tickets { ticketId: UUID, customerId: UUID, subject: String, openedAt: DateTime }
}

slice "Ticket Queue" {
  view Ticket Queue from "Ticket Opened" { ticketId: UUID, subject: String, openedAt: DateTime }
  ui Queue Screen @Agent
}

slice "Resolve Ticket" {
  ui Ticket Screen @Agent
  command Resolve Ticket { ticketId: UUID, resolution: String, resolvedAt: DateTime }
  event Ticket Resolved @Tickets { ticketId: UUID, resolution: String, resolvedAt: DateTime }
}

slice "Ticket Queue after resolve" {
  view Ticket Queue again from "Ticket Resolved" { ticketId: UUID, resolvedAt: DateTime }
  ui Queue Screen @Agent
}

slice "Stale Tickets" {
  view Stale Tickets from "Ticket Opened", "Ticket Resolved" { ticketId: UUID, openedAt: DateTime, resolvedAt: DateTime }
}

slice "Escalate Stale Ticket" {
  processor Stale Ticket Escalator from "Stale Tickets"
  command Escalate Ticket { ticketId: UUID, escalatedAt: DateTime }
  event Ticket Escalated @Escalations { ticketId: UUID, escalatedAt: DateTime }
}

slice "Escalated Tickets" {
  view Escalated Tickets from "Ticket Escalated" { ticketId: UUID, escalatedAt: DateTime }
  ui Escalations Screen @Agent
}
