// Toy fixture code (eval/conform/helpdesk, GH #452) — not built, not run.
//
// Implements the "Open Ticket" slice (model/slices/open-ticket.md). The doc's INV-OPEN-1 says:
// "subject must not be empty — an empty subject is rejected with a validation error before
// the event is recorded." This handler never checks that — SEEDED SPEC-SURFACE DRIFT (case b):
// a named invariant the doc claims is enforced, with no enforcement site in the code.

export interface OpenTicketCommand {
  ticketId: string;
  subject: string;
}

export interface TicketOpenedEvent {
  ticketId: string;
  subject: string;
}

export class OpenTicketHandler {
  handle(cmd: OpenTicketCommand): TicketOpenedEvent {
    // NOTE: no validation of `cmd.subject` here at all — an empty string is accepted and
    // recorded as-is. INV-OPEN-1 ("subject must not be empty") has no enforcement site.
    return { ticketId: cmd.ticketId, subject: cmd.subject };
  }
}
