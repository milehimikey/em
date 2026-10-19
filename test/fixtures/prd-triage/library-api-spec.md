# Lending Library API v2

## Walkthroughs

### Walkthrough 1: borrow and return a book

A member reserves a book. When the book is on the shelf the librarian checks it out to the
member, who returns it before the due date.

### Walkthrough 2: retire a damaged book

A librarian marks a damaged book as retired and it is removed from the catalog.

## Resources

`POST /loans` creates a loan record in the `loans` table.

`PATCH /books/{id}` updates any field on a book.

## Operational notes

The service is deployed as a single container and the API must stay available 99.9% of the time.
