model "Library Lending"

persona Member
persona Librarian
context Lending
context Notifications

slice "Borrow Book" {
  ui Catalog Page @Member
  command Borrow Book { loanId: UUID, memberId: UUID, bookId: UUID, dueOn: Date }
  event Book Borrowed @Lending { loanId: UUID, memberId: UUID, bookId: UUID, dueOn: Date }
}

slice "Active Loans" {
  view Active Loans from "Book Borrowed" { loanId: UUID, memberId: UUID, bookId: UUID, dueOn: Date }
  ui My Loans Page @Member
}

slice "Return Book" {
  ui Returns Desk @Librarian
  command Return Book { loanId: UUID, returnedOn: Date }
  event Book Returned @Lending { loanId: UUID, returnedOn: Date }
}

slice "Active Loans after return" {
  view Active Loans again from "Book Returned" { loanId: UUID, returnedOn: Date }
  ui My Loans Page @Member
}

slice "Loans To Check" {
  view Loans To Check from "Book Borrowed" { loanId: UUID, memberId: UUID, dueOn: Date }
}

slice "Send Overdue Notice" {
  processor Overdue Notifier from "Loans To Check"
  command Send Overdue Notice { loanId: UUID, memberId: UUID, sentOn: Date }
  event Overdue Notice Sent @Notifications { loanId: UUID, memberId: UUID, sentOn: Date }
}

slice "Notice Log" {
  view Notice Log from "Overdue Notice Sent" { loanId: UUID, sentOn: Date }
  ui Notice Log Page @Librarian
}
