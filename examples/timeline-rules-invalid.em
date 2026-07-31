model "Timeline Rules (invalid)"

# The companion to timeline-rules.em: every arrow below breaks one of the four
# patterns, and `em validate` rejects all of them. Run it to see the diagnostics:
#
#     em validate examples/timeline-rules-invalid.em
#
# Because these are errors, the model will not render — which is the point. em
# infers legal connections from slice shape, so a hand-written `arrow` is the one
# way an illegal connection can get into a model, and it is checked as such.

persona Agent

context Ticket

slice "Open Ticket" {
  ui Ticket Form @Agent
  command Open Ticket
  event Ticket Opened @Ticket
}

slice "Ticket Queue" {
  view Ticket Queue from "Ticket Opened"
  ui Queue Board @Agent
}

slice "Assign Ticket" {
  command Assign Ticket
  event Ticket Assigned @Ticket
}

slice "Queue After Assignment" {
  view Ticket Queue again from "Ticket Assigned"
}

# 1. A command straight to a read model. The CQRS violation: writes are only ever
#    visible to a reader through the event they recorded.
arrow "Open Ticket" -> "Ticket Queue"

# 2. A read model straight to a command. Reads never drive a write directly; a
#    processor or translation watches the read model and issues the command.
arrow "Ticket Queue" -> "Assign Ticket"

# 3. An event straight to a command. Same gap as above, one step earlier: the
#    event has to be projected into a read model that a reaction watches.
arrow "Ticket Opened" -> "Assign Ticket"

# 4. Event to event. Nothing derives an event but a command deciding to record it.
arrow "Ticket Opened" -> "Ticket Assigned"

# 5. Two instances of one read model. The repeat is a timeline device, not a flow —
#    see timeline-rules.em and docs/timeline.md.
arrow "Ticket Queue" -> "Ticket Queue"
