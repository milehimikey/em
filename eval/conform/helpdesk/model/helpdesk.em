model "Helpdesk"

persona Agent
context Support

# --- Command pattern: UI -> command -> event ---
# INV-OPEN-1 (slices/open-ticket.md) claims the handler rejects an empty subject. The
# toy codebase's handler (repo/src/support/open-ticket/OpenTicketHandler.ts) never checks it —
# seeded SPEC-surface drift (case b).
slice "Open Ticket" {
  ui New Ticket Form @Agent
  command Open Ticket note "slices/open-ticket.md" {
    ticketId: UUID
    subject: String
  }
  event Ticket Opened @Support {
    ticketId: UUID
    subject: String
  }
}

# --- Read model the automation watches, in its own slice (the to-do list) ---
# Implemented as a direct @EventHandler + criteria-sourced state entity, no materialized
# projection table — the legitimate idiom reference/conform.md names explicitly. A conform run
# must NOT report this as a missing projection — seeded FALSE-POSITIVE BAIT (case d).
slice "Tickets Awaiting Escalation" {
  view Tickets Awaiting Escalation from "Ticket Opened" note "slices/tickets-awaiting-escalation.md" {
    ticketId: UUID
    subject: String
  }
}

# --- Automation slice: the processor, the command it triggers, and that command's event ---
# The code's event carries an extra `escalationReason` field the model never declared —
# seeded STRUCTURAL drift (case a), and the one seed that lands on a changed path so the
# diff-scoped conform-scope run (Last conformance: the baseline revision) actually has to
# find it rather than being handed it by a full scope.
slice "Escalate Ticket" {
  processor Escalation Watcher from "Tickets Awaiting Escalation"
  command Escalate Ticket note "slices/escalate-ticket.md" {
    ticketId: UUID
    escalatedOn: Date
  }
  event Ticket Escalated @Support {
    ticketId: UUID
    escalatedOn: Date
  }
}

# --- View pattern: board ---
# slices/ticket-board.md's frontmatter claims `pattern: automation`; the model (view + ui,
# no command/processor) classifies as state-view — seeded INTERNAL inconsistency (case c),
# doc vs .em, no code involved.
slice "Ticket Board" {
  view Ticket Board from "Ticket Opened", "Ticket Escalated" note "slices/ticket-board.md" {
    ticketId: UUID
    subject: String
  }
  ui Board Page @Agent
}
