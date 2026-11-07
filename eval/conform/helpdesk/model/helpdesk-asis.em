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
# AS-IS EVIDENCE (eval/conform/helpdesk/repo-head/src/support/escalation/EscalateTicketHandler.ts):
# the code's "Ticket Escalated" event carries a third field, `escalationReason`, the canonical
# model (../model/helpdesk.em) never declared. `em diff` against the canonical model reports
# this as a `field-added` entry on the "Ticket Escalated" event — the mechanical half of the
# seeded STRUCTURAL drift (case a). Everything else in this slice is unchanged.
slice "Escalate Ticket" {
  processor Escalation Watcher from "Tickets Awaiting Escalation"
  command Escalate Ticket note "slices/escalate-ticket.md" {
    ticketId: UUID
    escalatedOn: Date
    escalationReason: String
  }
  event Ticket Escalated @Support {
    ticketId: UUID
    escalatedOn: Date
    escalationReason: String
  }
}

# --- View pattern: board ---
# slices/ticket-board.md's frontmatter claims `pattern: automation`; the model (view + ui,
# no command/processor) classifies as state-view — seeded INTERNAL inconsistency (case c),
# doc vs .em, no code involved. No structural change here.
slice "Ticket Board" {
  view Ticket Board from "Ticket Opened", "Ticket Escalated" note "slices/ticket-board.md" {
    ticketId: UUID
    subject: String
  }
  ui Board Page @Agent
}
