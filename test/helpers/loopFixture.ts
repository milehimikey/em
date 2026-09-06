// SPDX-License-Identifier: MIT
// Shared `loops-to` fixture (MIL-199, R12): the invented room-booking/waitlist domain from
// `internal/engagements/human-gate-2026-09/findings/recon-pilot.md` §8 ("FIXTURE DRAFT A"),
// adjusted until `em validate` is warning-free — `Room Booked` had no reader in the recon
// draft (fixed here with `See Room`/`Room Listing`), and every command needed an explicit
// trigger (a `ui` in its own slice, or the reaction it shares a slice with).
//
// Reproduces the pilot's real loop shape (an expire/withdraw-style event re-feeding an earlier
// to-do-list view, per the engagement's domain-neutrality rule — the pilot's own names never
// appear here): a to-do-list view (`Entries To Notify`) fed by two events, read one slice later
// by a reaction that triggers a notification; several slices further along, `Waitlist Entry
// Expired` must re-feed that same earlier view so the next waiting requester is told — the
// loop-back `loops-to` exists to express.
export const LOOP_FIXTURE = `model "room-booking-fixture"

persona Requester
context Room
context Waitlist

slice "Book Room" {
  ui Book Room Screen @Requester
  command Book Room {
    roomId: UUID
    requesterPhone: String
  }
  event Room Booked @Room {
    bookingId: UUID assigned
    roomId: UUID
    requesterPhone: String
    bookedAt: Instant assigned
  }
}

slice "See Room" {
  view Room Listing from "Room Booked"
  ui Room Listing Screen @Requester
}

slice "Join Waitlist" {
  ui Join Waitlist Screen @Requester
  command Join Waitlist {
    roomId: UUID
    requesterPhone: String
  }
  event Waitlist Entry Added @Waitlist {
    entryId: UUID assigned
    roomId: UUID
    requesterPhone: String
    addedAt: Instant assigned
  }
}

slice "Free Room" {
  ui Free Room Screen @Requester
  command Free Room {
    roomId: UUID
  }
  event Room Freed @Room {
    roomId: UUID
    freedAt: Instant assigned
  }
}

slice "Entries To Notify" {
  view Entries To Notify from "Waitlist Entry Added", "Room Freed"
}

slice "Notify Waitlist Entry" {
  processor Waitlist Notifier from "Entries To Notify"
  command Notify Waitlist Entry {
    entryId: UUID
    roomId: UUID
    requesterPhone: String
  }
  event Waitlist Entry Notified @Waitlist {
    entryId: UUID
    roomId: UUID
    requesterPhone: String
    notifiedAt: Instant assigned
    respondBy: Date assigned
  }
}

slice "Entries Awaiting Response" {
  view Entries Awaiting Response from "Waitlist Entry Notified"
}

slice "Expire Waitlist Entry" {
  processor Response Watcher from "Entries Awaiting Response"
  command Expire Waitlist Entry {
    entryId: UUID
    roomId: UUID
    requesterPhone: String
  }
  event Waitlist Entry Expired @Waitlist {
    entryId: UUID
    roomId: UUID
    requesterPhone: String
    expiredAt: Instant assigned
  } loops-to "Entries To Notify"
}
`;
