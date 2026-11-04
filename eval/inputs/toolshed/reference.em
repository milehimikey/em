model "toolshed"

persona Neighbor
persona Shed Manager

context Tools
context Loans
context Holds
context Neighbors

type LateReturnFact { loanId: LoanId, toolName: Text, dueDate: Date, returnedOn: Date }
type LateReturn { loanId: LoanId, toolName: Text, dueDate: Date, returnedOn: Date, flaggedAt: Instant }

# Timeline order, left to right, grouped into storylines: the main journey (Borrow and return a
# tool) and the chapters around it. Human-triggered State Change slices are ui -> command -> event.
# Read models repeat right after the event that feeds them.

storyline "Stock the shed" {
  slice "Add Tool" {
    ui Tool Inventory @Shed Manager
    command Add Tool { toolId: ToolId, name: Text, description: Text, defaultCheckoutPeriodDays: Int } note "slices/add-tool.md"
    event Tool Added { toolId: ToolId, name: Text, description: Text, defaultCheckoutPeriodDays: Int, addedAt: Instant assigned } @Tools
  }
  slice "Tool Inventory" {
    view Tool Inventory from "Tool Added" { toolId: ToolId, name: Text, description: Text, defaultCheckoutPeriodDays: Int, addedAt: Instant, onLoan: Bool derived, loanId: LoanId derived, borrowerId: NeighborId derived, borrowerName: Text derived, dueDate: Date derived, retired: Bool derived, canRetire: Bool derived, canMarkLost: Bool derived, overdue: Bool derived } note "slices/tool-inventory.md"
    ui Tool Inventory @Shed Manager
  }
  slice "Tool Catalog" {
    view Tool Catalog from "Tool Added" { toolId: ToolId, name: Text, description: Text, defaultCheckoutPeriodDays: Int, addedAt: Instant, status: Text derived, dueDate: Date derived, holdsWaiting: Int derived, canCheckOut: Bool derived, canPlaceHold: Bool derived } note "slices/tool-catalog.md"
    ui Tool Catalog @Neighbor
  }
}

storyline "Join the shed" {
  slice "Register Neighbor" {
    ui Sign Up @Neighbor
    command Register Neighbor { neighborId: NeighborId, name: Text, email: Text } note "slices/register-neighbor.md"
    event Neighbor Registered { neighborId: NeighborId, name: Text, email: Text, registeredAt: Instant assigned } @Neighbors
  }
  slice "Neighbors" {
    view Neighbors from "Neighbor Registered" { neighborId: NeighborId, name: Text, email: Text, registeredAt: Instant, status: Text derived, suspendedAt: Instant derived, flagCount: Int derived, latestFlaggedAt: Instant derived, lateReturns: LateReturn[] derived, canSuspend: Bool derived, canReinstate: Bool derived } note "slices/neighbors.md"
    ui Neighbors @Shed Manager
  }
  slice "My Account" {
    view My Account from "Neighbor Registered" { neighborId: NeighborId, name: Text, email: Text, status: Text derived, canChangeEmail: Bool derived, canCloseAccount: Bool derived } note "slices/my-account.md"
    ui My Account @Neighbor
  }

  slice "Change Email" {
    ui My Account @Neighbor
    command Change Email { neighborId: NeighborId, email: Text } note "slices/change-email.md"
    event Neighbor Email Changed { neighborId: NeighborId, email: Text, changedAt: Instant assigned } @Neighbors
  }
  slice "My Account — email changed" {
    view My Account again from "Neighbor Email Changed"
    ui My Account @Neighbor
  }
  slice "Neighbors — email changed" {
    view Neighbors again from "Neighbor Email Changed"
    ui Neighbors @Shed Manager
  }
}

storyline "Borrow and return a tool" {
  slice "Check Out Tool" {
    ui Tool Catalog @Neighbor
    command Check Out Tool { loanId: LoanId, toolId: ToolId, neighborId: NeighborId, loanPeriodDays: Int } note "slices/check-out-tool.md"
    event Tool Checked Out { loanId: LoanId, toolId: ToolId, toolName: Text assigned, neighborId: NeighborId, neighborName: Text assigned, neighborEmail: Text assigned, loanPeriodDays: Int, dueDate: Date assigned, checkedOutAt: Instant assigned } @Loans
  }
  slice "Tool Inventory — tool checked out" {
    view Tool Inventory again from "Tool Checked Out"
    ui Tool Inventory @Shed Manager
  }
  slice "Tool Catalog — checked out" {
    view Tool Catalog again from "Tool Checked Out"
    ui Tool Catalog @Neighbor
  }
  slice "My Loans" {
    view My Loans from "Tool Checked Out" { loanId: LoanId, neighborId: NeighborId, toolId: ToolId, toolName: Text, checkedOutAt: Instant, dueDate: Date, overdue: Bool derived, overdueNotice: Text derived, holdWaiting: Bool derived, toolRetired: Bool derived, canExtend: Bool derived } note "slices/my-loans.md"
    ui My Loans @Neighbor
  }

  slice "Extend Loan" {
    ui My Loans @Neighbor
    command Extend Loan { neighborId: NeighborId, loanId: LoanId, fromDueDate: Date } note "slices/extend-loan.md"
    event Loan Extended { loanId: LoanId, fromDueDate: Date, dueDate: Date assigned, extendedAt: Instant assigned } @Loans
  }
  slice "Tool Inventory — loan extended" {
    view Tool Inventory again from "Loan Extended"
    ui Tool Inventory @Shed Manager
  }
  slice "My Loans — loan extended" {
    view My Loans again from "Loan Extended"
    ui My Loans @Neighbor
  }
  slice "Tool Catalog — loan extended" {
    view Tool Catalog again from "Loan Extended"
    ui Tool Catalog @Neighbor
  }

  slice "Return Tool" {
    ui My Loans @Neighbor
    command Return Tool { neighborId: NeighborId, loanId: LoanId } note "slices/return-tool.md"
    event Tool Returned { loanId: LoanId, toolId: ToolId assigned, toolName: Text assigned, neighborId: NeighborId assigned, dueDate: Date assigned, returnedAt: Instant assigned, returnedOn: Date assigned, late: Bool assigned } @Loans
  }
  slice "Tool Inventory — tool returned" {
    view Tool Inventory again from "Tool Returned"
    ui Tool Inventory @Shed Manager
  }
  slice "Tool Catalog — tool returned" {
    view Tool Catalog again from "Tool Returned"
    ui Tool Catalog @Neighbor
  }
  slice "My Loans — tool returned" {
    view My Loans again from "Tool Returned"
    ui My Loans @Neighbor
  }
}

storyline "Chase an overdue loan" after "Borrow and return a tool" {
  slice "Overdue Loans To Notify" {
    view Overdue Loans To Notify from "Tool Checked Out", "Neighbor Email Changed", "Loan Extended", "Tool Returned" { loanId: LoanId, toolId: ToolId, neighborId: NeighborId, dueDate: Date, toolName: Text, borrowerName: Text derived from "Tool Checked Out", borrowerEmail: Text derived from "Tool Checked Out", "Neighbor Email Changed", overdue: Bool derived } note "slices/overdue-loans-to-notify.md"
  }

  # Internally triggered translation: the gateway watches the to-do view and hands notices to the provider.
  slice "Send Overdue Notice" {
    translation Overdue Notice Gateway from "Overdue Loans To Notify" note "slices/send-overdue-notice.md"
    command Send Overdue Notice { loanId: LoanId, neighborId: NeighborId, sentTo: Text, borrowerName: Text, toolName: Text, dueDate: Date }
    event Overdue Notice Sent { loanId: LoanId, neighborId: NeighborId, sentTo: Text, borrowerName: Text, toolName: Text, dueDate: Date, sentAt: Instant assigned } loops-to "Overdue Loans To Notify" @Loans
  }
  slice "My Loans — overdue notice sent" {
    view My Loans again from "Overdue Notice Sent"
    ui My Loans @Neighbor
  }

  slice "Record Overdue Notice Failure" {
    translation Email Provider Failure Report note "slices/record-overdue-notice-failure.md" divergence "No email provider selected yet (constitution Amendment 8): no inbound transport reaches this translation and its verifier fails closed until a provider is chosen; the mapping code is in place (conformance 2026-11-01, rulings 2 and 3)"
    command Record Overdue Notice Failure { loanId: LoanId, reason: Text }
    event Overdue Notice Failed { loanId: LoanId, neighborId: NeighborId assigned, neighborName: Text assigned, neighborEmail: Text assigned, toolName: Text assigned, dueDate: Date assigned, reason: Text, failedAt: Instant assigned } @Loans
  }
  slice "My Loans — overdue notice failed" {
    view My Loans again from "Overdue Notice Failed"
    ui My Loans @Neighbor
  }
  slice "Undelivered Notices" {
    view Undelivered Notices from "Overdue Notice Failed", "Neighbor Email Changed", "Loan Extended", "Tool Returned" { kind: Text derived, loanId: LoanId, holdId: HoldId derived, neighborId: NeighborId, neighborName: Text, neighborEmail: Text derived from "Overdue Notice Failed", "Neighbor Email Changed", toolId: ToolId derived, toolName: Text, dueDate: Date, collectByDate: Date derived, reason: Text, failedAt: Instant } note "slices/undelivered-notices.md"
    ui Undelivered Notices @Shed Manager
  }
}

storyline "Hold a tool for pickup" after "Borrow and return a tool" {
  slice "Place Hold" {
    ui Tool Catalog @Neighbor
    command Place Hold { holdId: HoldId, toolId: ToolId, neighborId: NeighborId } note "slices/place-hold.md"
    event Hold Placed { holdId: HoldId, toolId: ToolId, toolName: Text assigned, neighborId: NeighborId, neighborName: Text assigned, neighborEmail: Text assigned, placedAt: Instant assigned } @Holds
  }
  slice "My Holds" {
    view My Holds from "Hold Placed" { holdId: HoldId, neighborId: NeighborId, toolId: ToolId, toolName: Text, placedAt: Instant, status: Text derived, position: Int derived, collectByDate: Date derived, pickupNotice: Text derived, canCancel: Bool derived } note "slices/my-holds.md"
    ui My Holds @Neighbor
  }
  slice "Tool Catalog — hold placed" {
    view Tool Catalog again from "Hold Placed"
    ui Tool Catalog @Neighbor
  }
  slice "My Loans — hold placed" {
    view My Loans again from "Hold Placed"
    ui My Loans @Neighbor
  }

  slice "Holds To Collect" {
    view Holds To Collect from "Hold Placed", "Tool Checked Out" { holdId: HoldId, toolId: ToolId, neighborId: NeighborId, loanId: LoanId derived from "Tool Checked Out" } note "slices/holds-to-collect.md"
  }

  # The holder taking the tool out is an ordinary checkout; the collector then closes their hold.
  slice "Collect Hold" {
    processor Hold Collector from "Holds To Collect" note "slices/collect-hold.md"
    command Collect Hold { holdId: HoldId, loanId: LoanId }
    event Hold Collected { holdId: HoldId, toolId: ToolId assigned, neighborId: NeighborId assigned, loanId: LoanId, collectedAt: Instant assigned } loops-to "Holds To Collect" @Holds
  }
  slice "My Holds — hold collected" {
    view My Holds again from "Hold Collected"
    ui My Holds @Neighbor
  }
  slice "Undelivered Notices — hold collected" {
    view Undelivered Notices again from "Hold Collected"
    ui Undelivered Notices @Shed Manager
  }

  slice "Cancel Hold" {
    ui My Holds @Neighbor
    command Cancel Hold { neighborId: NeighborId, holdId: HoldId } note "slices/cancel-hold.md"
    event Hold Cancelled { holdId: HoldId, cancelledAt: Instant assigned } loops-to "Holds To Collect" @Holds
  }
  slice "My Holds — hold cancelled" {
    view My Holds again from "Hold Cancelled"
    ui My Holds @Neighbor
  }
  slice "Tool Catalog — hold cancelled" {
    view Tool Catalog again from "Hold Cancelled"
    ui Tool Catalog @Neighbor
  }
  slice "My Loans — hold cancelled" {
    view My Loans again from "Hold Cancelled"
    ui My Loans @Neighbor
  }
  slice "Undelivered Notices — hold cancelled" {
    view Undelivered Notices again from "Hold Cancelled"
    ui Undelivered Notices @Shed Manager
  }

  slice "Holds To Fulfill" {
    view Holds To Fulfill from "Hold Placed", "Hold Collected", "Tool Returned", "Hold Cancelled", "Tool Checked Out" { toolId: ToolId, holdId: HoldId derived, neighborId: NeighborId derived } note "slices/holds-to-fulfill.md"
  }

  slice "Fulfill Hold" {
    processor Hold Fulfiller from "Holds To Fulfill" note "slices/fulfill-hold.md"
    command Fulfill Hold { holdId: HoldId }
    event Hold Fulfilled { holdId: HoldId, toolId: ToolId assigned, toolName: Text assigned, neighborId: NeighborId assigned, neighborName: Text assigned, neighborEmail: Text assigned, collectByDate: Date assigned, fulfilledAt: Instant assigned } loops-to "Holds To Fulfill" @Holds
  }
  slice "Tool Catalog — hold fulfilled" {
    view Tool Catalog again from "Hold Fulfilled"
    ui Tool Catalog @Neighbor
  }
  slice "My Holds — hold fulfilled" {
    view My Holds again from "Hold Fulfilled"
    ui My Holds @Neighbor
  }

  slice "Pickup Notices To Send" {
    view Pickup Notices To Send from "Hold Fulfilled", "Hold Cancelled", "Hold Collected", "Neighbor Email Changed" { holdId: HoldId, toolId: ToolId, neighborId: NeighborId, collectByDate: Date, holderName: Text derived from "Hold Fulfilled", holderEmail: Text derived from "Hold Fulfilled", "Neighbor Email Changed", toolName: Text } note "slices/pickup-notices-to-send.md"
  }

  slice "Send Pickup Notice" {
    translation Pickup Notice Gateway from "Pickup Notices To Send" note "slices/send-pickup-notice.md"
    command Send Pickup Notice { holdId: HoldId, neighborId: NeighborId, sentTo: Text, holderName: Text, toolName: Text, collectByDate: Date }
    event Pickup Notice Sent { holdId: HoldId, neighborId: NeighborId, sentTo: Text, holderName: Text, toolName: Text, collectByDate: Date, sentAt: Instant assigned } loops-to "Pickup Notices To Send" @Holds
  }
  slice "My Holds — pickup notice sent" {
    view My Holds again from "Pickup Notice Sent"
    ui My Holds @Neighbor
  }

  slice "Record Pickup Notice Failure" {
    translation Pickup Email Failure Report note "slices/record-pickup-notice-failure.md" divergence "No email provider selected yet (constitution Amendment 8): no inbound transport reaches this translation and its verifier fails closed until a provider is chosen; the mapping code is in place (conformance 2026-11-01, rulings 2 and 3)"
    command Record Pickup Notice Failure { holdId: HoldId, reason: Text }
    event Pickup Notice Failed { holdId: HoldId, toolId: ToolId assigned, neighborId: NeighborId assigned, neighborName: Text assigned, neighborEmail: Text assigned, toolName: Text assigned, collectByDate: Date assigned, reason: Text, failedAt: Instant assigned } @Holds
  }
  slice "My Holds — pickup notice failed" {
    view My Holds again from "Pickup Notice Failed"
    ui My Holds @Neighbor
  }
  slice "Undelivered Notices — pickup notice failed" {
    view Undelivered Notices again from "Pickup Notice Failed"
    ui Undelivered Notices @Shed Manager
  }

  slice "Pickups To Expire" {
    view Pickups To Expire from "Hold Fulfilled", "Hold Collected", "Hold Cancelled" { holdId: HoldId, toolId: ToolId, neighborId: NeighborId, collectByDate: Date, dueToExpire: Bool derived } note "slices/pickups-to-expire.md"
  }

  slice "Expire Hold" {
    processor Pickup Expirer from "Pickups To Expire" note "slices/expire-hold.md"
    command Expire Hold { holdId: HoldId }
    event Hold Expired { holdId: HoldId, expiredAt: Instant assigned } loops-to "Holds To Fulfill", "Pickups To Expire", "Pickup Notices To Send" @Holds
  }
  slice "My Loans — hold expired" {
    view My Loans again from "Hold Expired"
    ui My Loans @Neighbor
  }
  slice "My Holds — hold expired" {
    view My Holds again from "Hold Expired"
    ui My Holds @Neighbor
  }
  slice "Tool Catalog — hold expired" {
    view Tool Catalog again from "Hold Expired"
    ui Tool Catalog @Neighbor
  }
  slice "Undelivered Notices — hold expired" {
    view Undelivered Notices again from "Hold Expired"
    ui Undelivered Notices @Shed Manager
  }
}

storyline "Keep late returners in check" after "Borrow and return a tool" {
  slice "Neighbors To Flag" {
    view Neighbors To Flag from "Tool Returned" { neighborId: NeighborId, loanId: LoanId, toolName: Text, dueDate: Date, returnedOn: Date, inWindow: Bool derived } note "slices/neighbors-to-flag.md"
  }

  slice "Flag Neighbor" {
    processor Late Return Flagger from "Neighbors To Flag" note "slices/flag-neighbor.md"
    command Flag Neighbor { neighborId: NeighborId, lateReturns: LateReturnFact[] }
    event Neighbor Flagged { neighborId: NeighborId, lateReturns: LateReturnFact[], flaggedAt: Instant assigned } loops-to "Neighbors To Flag" @Neighbors
  }
  slice "Neighbors — neighbor flagged" {
    view Neighbors again from "Neighbor Flagged"
    ui Neighbors @Shed Manager
  }

  slice "Suspend Neighbor" {
    ui Neighbors @Shed Manager
    command Suspend Neighbor { neighborId: NeighborId } note "slices/suspend-neighbor.md"
    event Neighbor Suspended { neighborId: NeighborId, suspendedAt: Instant assigned } loops-to "Neighbors To Flag" @Neighbors
  }
  slice "Neighbors — neighbor suspended" {
    view Neighbors again from "Neighbor Suspended"
    ui Neighbors @Shed Manager
  }
  slice "My Account — neighbor suspended" {
    view My Account again from "Neighbor Suspended"
    ui My Account @Neighbor
  }

  slice "Reinstate Neighbor" {
    ui Neighbors @Shed Manager
    command Reinstate Neighbor { neighborId: NeighborId } note "slices/reinstate-neighbor.md"
    event Neighbor Reinstated { neighborId: NeighborId, reinstatedAt: Instant assigned } loops-to "Neighbors To Flag" @Neighbors
  }
  slice "Neighbors — neighbor reinstated" {
    view Neighbors again from "Neighbor Reinstated"
    ui Neighbors @Shed Manager
  }
  slice "My Account — neighbor reinstated" {
    view My Account again from "Neighbor Reinstated"
    ui My Account @Neighbor
  }
}

storyline "Take a tool or a neighbor out of the shed" {
  slice "Retire Tool" {
    ui Tool Inventory @Shed Manager
    command Retire Tool { toolId: ToolId } note "slices/retire-tool.md"
    event Tool Retired { toolId: ToolId, retiredAt: Instant assigned } @Tools
    event Hold Cancelled @Holds
  }
  slice "My Holds — tool retired" {
    view My Holds again from "Hold Cancelled"
    ui My Holds @Neighbor
  }
  slice "Tool Inventory — tool retired" {
    view Tool Inventory again from "Tool Retired"
    ui Tool Inventory @Shed Manager
  }
  slice "Tool Catalog — tool retired" {
    view Tool Catalog again from "Tool Retired"
    ui Tool Catalog @Neighbor
  }
  slice "My Loans — tool retired" {
    view My Loans again from "Tool Retired"
    ui My Loans @Neighbor
  }

  slice "Record Tool Lost" {
    ui Tool Inventory @Shed Manager
    command Record Tool Lost { loanId: LoanId, toolId: ToolId } note "slices/record-tool-lost.md"
    event Tool Lost { loanId: LoanId, toolId: ToolId assigned, lostAt: Instant assigned } loops-to "Overdue Loans To Notify" @Tools
    event Hold Cancelled @Holds
  }
  slice "My Holds — tool lost" {
    view My Holds again from "Hold Cancelled"
    ui My Holds @Neighbor
  }
  slice "Tool Inventory — tool lost" {
    view Tool Inventory again from "Tool Lost"
    ui Tool Inventory @Shed Manager
  }
  slice "Tool Catalog — tool lost" {
    view Tool Catalog again from "Tool Lost"
    ui Tool Catalog @Neighbor
  }
  slice "My Loans — tool lost" {
    view My Loans again from "Tool Lost"
    ui My Loans @Neighbor
  }
  slice "Undelivered Notices — tool lost" {
    view Undelivered Notices again from "Tool Lost"
    ui Undelivered Notices @Shed Manager
  }

  slice "Close Account" {
    ui My Account @Neighbor
    command Close Account { neighborId: NeighborId } note "slices/close-account.md"
    event Neighbor Account Closed { neighborId: NeighborId, whileSuspended: Bool assigned, closedAt: Instant assigned } loops-to "Neighbors To Flag" @Neighbors
    event Hold Cancelled @Holds
  }
  slice "My Holds — account closed" {
    view My Holds again from "Hold Cancelled"
    ui My Holds @Neighbor
  }
  slice "My Account — account closed" {
    view My Account again from "Neighbor Account Closed"
    ui My Account @Neighbor
  }
  slice "Neighbors — account closed" {
    view Neighbors again from "Neighbor Account Closed"
    ui Neighbors @Shed Manager
  }
}
