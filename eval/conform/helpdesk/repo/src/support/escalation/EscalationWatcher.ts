// Toy fixture code (eval/conform/helpdesk, GH #452) — not built, not run.
//
// Implements the "Tickets Awaiting Escalation" slice's watched view (model/slices/
// tickets-awaiting-escalation.md) AND the "Escalate Ticket" automation's trigger
// (model/slices/escalate-ticket.md).
//
// Deliberate idiom, NOT a bug: there is no materialized `TicketsAwaitingEscalation`
// projection/table anywhere in this codebase. The watched view is a direct @EventHandler
// keeping a criteria-sourced, in-memory state entity — exactly the pattern
// `.claude/skills/event-modeling-conform/reference/conform.md` calls out under "Legitimate
// non-materialized views": the automation's own read, not an endpoint promise. A conform run
// must NOT report "the Tickets Awaiting Escalation view has no projection" against this file —
// SEEDED FALSE-POSITIVE BAIT (case d).

interface TicketOpenedEvent {
  ticketId: string;
  subject: string;
}

/** Criteria-sourced state entity (DCB-style): rebuilt from `Ticket Opened`/`Ticket Escalated`
 *  on demand, never written to a separate table. This IS the "Tickets Awaiting Escalation"
 *  view, expressed as code — not a stand-in for a missing one. */
class EscalationCandidate {
  constructor(public ticketId: string, public subject: string) {}
}

export class EscalationWatcher {
  private candidates = new Map<string, EscalationCandidate>();

  /** @EventHandler Ticket Opened — puts the ticket on the candidate list. */
  onTicketOpened(event: TicketOpenedEvent): void {
    this.candidates.set(event.ticketId, new EscalationCandidate(event.ticketId, event.subject));
  }

  /** @EventHandler Ticket Escalated — takes the ticket off the candidate list (housekeeping,
   *  not drawn as a trigger — same `updates from` idea the model's `view ... from` captures for
   *  real materialized views). */
  onTicketEscalated(ticketId: string): void {
    this.candidates.delete(ticketId);
  }

  /** What the automation actually reads — this method, not a query against a table, is the
   *  "Tickets Awaiting Escalation" view's runtime shape. */
  candidatesDueForEscalation(): EscalationCandidate[] {
    return [...this.candidates.values()];
  }
}
