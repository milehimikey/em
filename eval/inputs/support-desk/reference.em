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

# A genuine run of three consecutive same-context State Change slices (all @Tickets; Ticket Opened is
# the same context too). The board that follows is NOT counted as entity-clustered because it also
# reads Ticket Opened, which comes from a slice outside the run, so the entity-clustered rate stays
# 0: this reference exercises the metric's negative case.
slice "Resolve Ticket" {
  ui Ticket Screen @Agent
  command Resolve Ticket { ticketId: UUID, resolution: String, resolvedAt: DateTime }
  event Ticket Resolved @Tickets { ticketId: UUID, resolution: String, resolvedAt: DateTime }
}

slice "Reopen Ticket" {
  ui Ticket Screen @Agent
  command Reopen Ticket { ticketId: UUID, reason: String, reopenedAt: DateTime }
  event Ticket Reopened @Tickets { ticketId: UUID, reason: String, reopenedAt: DateTime }
}

slice "Merge Ticket" {
  ui Ticket Screen @Agent
  command Merge Ticket { ticketId: UUID, intoTicketId: UUID, mergedAt: DateTime }
  event Ticket Merged @Tickets { ticketId: UUID, intoTicketId: UUID, mergedAt: DateTime }
}

slice "Ticket Board" {
  view Ticket Board from "Ticket Opened", "Ticket Resolved", "Ticket Reopened", "Ticket Merged" { ticketId: UUID, openedAt: DateTime, resolvedAt: DateTime, reopenedAt: DateTime, mergedAt: DateTime }
  ui Board Screen @Agent
}

slice "Stale Tickets" {
  view Stale Tickets from "Ticket Opened", "Ticket Resolved", "Ticket Reopened", "Ticket Merged" { ticketId: UUID, openedAt: DateTime, resolvedAt: DateTime, reopenedAt: DateTime, mergedAt: DateTime }
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
