// Toy fixture code (eval/conform/helpdesk, GH #452) — not built, not run.
//
// Implements the "Ticket Board" slice (model/slices/ticket-board.md). A real materialized
// projection, matching the model exactly (ticketId, subject) — this file carries no seeded
// code-side drift. The slice's seeded finding (case c, internal inconsistency) is doc vs
// `.em` only: slices/ticket-board.md's frontmatter says `pattern: automation`, but the model
// has only a view + ui here (state-view). Nothing below is wrong.

interface TicketOpenedEvent {
  ticketId: string;
  subject: string;
}

interface TicketEscalatedEvent {
  ticketId: string;
  escalatedOn: string;
}

interface TicketBoardRow {
  ticketId: string;
  subject: string;
}

export class TicketBoardProjection {
  private rows = new Map<string, TicketBoardRow>();

  /** @EventHandler Ticket Opened */
  onTicketOpened(event: TicketOpenedEvent): void {
    this.rows.set(event.ticketId, { ticketId: event.ticketId, subject: event.subject });
  }

  /** @EventHandler Ticket Escalated — the row stays on the board, just like the model says
   *  (Ticket Board reads both "Ticket Opened" and "Ticket Escalated"). */
  onTicketEscalated(_event: TicketEscalatedEvent): void {
    // no-op: escalation doesn't remove the row from the board.
  }

  /** Query endpoint the Board Page screen (@Agent) calls. */
  all(): TicketBoardRow[] {
    return [...this.rows.values()];
  }
}
