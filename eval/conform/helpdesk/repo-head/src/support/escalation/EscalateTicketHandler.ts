// Toy fixture code (eval/conform/helpdesk, GH #452) — not built, not run.
// HEAD overlay — `setup.mjs` copies this file over the baseline commit's copy, so it's the
// ONLY file that changes between the fixture's two commits. That's what makes the
// diff-scoped `em conform-scope` run land on exactly the escalate-ticket /
// tickets-awaiting-escalation slices (both docs' `implementedIn: src/support/escalation`) and
// nothing else — the hard requirement in GH #452 that at least one case exercise the
// diff-scoped path, not just full-scope.
//
// Implements the "Escalate Ticket" slice's command/event (model/slices/escalate-ticket.md).
// The model declares exactly two event fields: ticketId, escalatedOn. This revision's event
// carries a THIRD field, `escalationReason`, that neither the `.em` nor the slice doc
// declares — SEEDED STRUCTURAL DRIFT (case a): code carries a field the model lacks.

export interface EscalateTicketCommand {
  ticketId: string;
  escalatedOn: string;
  escalationReason: string;
}

export interface TicketEscalatedEvent {
  ticketId: string;
  escalatedOn: string;
  /** Not in the model (helpdesk.em's "Ticket Escalated" event: ticketId, escalatedOn only) or
   *  in slices/escalate-ticket.md. Added later so the board could show why a ticket was
   *  escalated — nobody updated the model when this shipped. */
  escalationReason: string;
}

export class EscalateTicketHandler {
  handle(cmd: EscalateTicketCommand): TicketEscalatedEvent {
    return { ticketId: cmd.ticketId, escalatedOn: cmd.escalatedOn, escalationReason: cmd.escalationReason };
  }
}
