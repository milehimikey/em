// Toy fixture code (eval/conform/helpdesk, GH #452) — not built, not run.
// BASELINE revision — see eval/conform/helpdesk/repo-head for the HEAD overlay that seeds the
// structural drift (case a) over this file.
//
// Implements the "Escalate Ticket" slice's command/event (model/slices/escalate-ticket.md).
// At this revision the event matches the model exactly: ticketId, escalatedOn.

export interface EscalateTicketCommand {
  ticketId: string;
  escalatedOn: string;
}

export interface TicketEscalatedEvent {
  ticketId: string;
  escalatedOn: string;
}

export class EscalateTicketHandler {
  handle(cmd: EscalateTicketCommand): TicketEscalatedEvent {
    return { ticketId: cmd.ticketId, escalatedOn: cmd.escalatedOn };
  }
}
