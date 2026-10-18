model "Product Catalog Storylines"

# Demonstrates GH #277's `storyline` blocks: a main storyline (the end-to-end journey) and two
# secondary ones, each a named chapter over a run of slices. Slices keep their file-order timeline
# position; the storyline is a label over them. Renders with a labelled band above the slice
# headers; `em render storylines.em --storyline "Retire a product"` draws one story alone.
#
# "Retire a product" declares `after "Bring a product to market"`: it is read as if its slices
# followed the main storyline's last slice, so its `Product Catalog again` continues the MAIN
# storyline's catalog — not the instance the "Extend an attribute" storyline (declared in between,
# with no `after`) happens to leave in file order.

persona Merchandiser

context Catalog

storyline "Bring a product to market" source "docs/catalog.md#walkthrough-1" {
  slice "Create Product" {
    ui Product Form @Merchandiser
    command Create Product { productId: UUID, name: string }
    event Product Created { productId: UUID, name: string }
  }

  slice "List Products" {
    view Product Catalog { productId: UUID, name: string } from "Product Created"
    ui Catalog Screen @Merchandiser
  }

  slice "Publish Product" {
    ui Publish Button @Merchandiser
    command Publish Product { productId: UUID }
    event Product Published { productId: UUID }
  }

  slice "List Published Products" {
    view Product Catalog again from "Product Published"
    ui Published Catalog Screen @Merchandiser
  }
}

storyline "Extend an attribute" source "docs/catalog.md#walkthrough-2" {
  slice "Add Product Attribute" {
    ui Attribute Form @Merchandiser
    command Add Product Attribute { productId: UUID, attribute: string }
    event Product Attribute Added { productId: UUID, attribute: string }
  }

  slice "List Attributes" {
    view Product Catalog again from "Product Attribute Added"
    ui Attribute Screen @Merchandiser
  }
}

storyline "Retire a product" after "Bring a product to market" {
  slice "Archive Product" {
    ui Archive Button @Merchandiser
    command Archive Product { productId: UUID }
    event Product Archived { productId: UUID }
  }

  slice "List Active Products" {
    view Product Catalog again from "Product Archived"
    ui Active Catalog Screen @Merchandiser
  }
}
