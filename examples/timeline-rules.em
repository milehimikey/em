model "Timeline Rules"

# A small support-desk model whose job is to demonstrate the connection rules em
# enforces, rather than to be a complete domain. Four things to look at:
#
#   1. Every slice is exactly one of the four patterns, and complete. A State Change
#      is ui -> command -> event; a State View is event -> read model -> ui (or a
#      reaction). No half-slices: nothing in here is a read model with no consumer,
#      a command with no trigger, or an event with no reader. The whole model is a
#      staircase of alternating State Change and State View slices.
#
#   2. "Ticket Queue" appears six times. The instances are NOT joined to each
#      other — continuity is implied by the shared name, and the events arriving
#      at each instance are what show the queue changing. A view->view arrow would
#      run flat through the commands between them and read as command -> read model.
#
#   3. Every arrow spans one slice. A read model goes directly after the event that
#      feeds it, so you can see the whole flow without tracing a line across the
#      diagram. The refund detour (slices 9-12) stays together for the same reason
#      rather than being parked at the end.
#
#   4. Every connection here is one of the six legal pairs. See timeline-rules-invalid.em
#      for the arrows `em validate` rejects, and why.

persona Agent

context Ticket
context Billing

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
  ui Queue Board @Agent
  command Assign Ticket
  event Ticket Assigned @Ticket
}

slice "Queue After Assignment" {
  view Ticket Queue again from "Ticket Assigned"
  ui Queue Board @Agent
}

slice "Reply To Customer" {
  ui Reply Composer @Agent
  command Reply To Customer
  event Reply Sent @Ticket
}

slice "Queue After Reply" {
  view Ticket Queue again from "Reply Sent"
  ui Queue Board @Agent
}

slice "Escalate Ticket" {
  ui Queue Board @Agent
  command Escalate Ticket
  event Ticket Escalated @Ticket
}

slice "Queue After Escalation" {
  view Ticket Queue again from "Ticket Escalated"
  ui Queue Board @Agent
}

# The refund detour. It crosses into the Billing context and back, and it is kept
# adjacent to the ticket flow rather than parked at the end of the model — a read
# model far from its event draws a long arrow that reads as a dangling slice.
slice "Request Refund" {
  ui Refund Form @Agent
  command Request Refund
  event Refund Requested @Billing
}

# A read model may be consumed by a reaction instead of a screen — that is the
# Automation pattern, and it is what makes this a complete State View.
slice "Refund Backlog" {
  view Refund Backlog from "Refund Requested"
  processor Refund Gateway
}

# A reaction never records an event itself: it triggers a command, in the next slice,
# and that command records the event.
slice "Issue Refund" {
  command Issue Refund
  event Refund Issued @Billing
}

# ...and the backlog clears, which is what reads the event the refund recorded.
slice "Backlog After Refund" {
  view Refund Backlog again from "Refund Issued"
  ui Refund Queue @Agent
}

slice "Resolve Ticket" {
  ui Queue Board @Agent
  command Resolve Ticket
  event Ticket Resolved @Ticket
}

slice "Queue After Resolution" {
  view Ticket Queue again from "Ticket Resolved"
  ui Queue Board @Agent
}

slice "Close Ticket" {
  ui Queue Board @Agent
  command Close Ticket
  event Ticket Closed @Ticket
}

slice "Queue After Close" {
  view Ticket Queue again from "Ticket Closed"
  ui Queue Board @Agent
}
