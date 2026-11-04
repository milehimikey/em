model "Toolshed (mini)"

persona Neighbor

context Tool
context Neighbor

slice "Add Tool" {
  ui Add Tool Form @Neighbor
  command Add Tool
  event Tool Added @Tool { toolId: UUID, toolName: String }
}

slice "Tool Catalog" {
  view Tool Catalog from "Tool Added"
  ui Browse Catalog @Neighbor
}

slice "Register Neighbor" {
  ui Registration Form @Neighbor
  command Register Neighbor
  event Neighbor Registered @Neighbor { neighborId: UUID, neighborName: String }
}

slice "Neighbors" {
  view Neighbors from "Neighbor Registered"
  ui Directory @Neighbor
}

slice "Check Out Tool" {
  ui Checkout Form @Neighbor
  command Check Out Tool
  event Tool Checked Out @Tool { toolId: UUID, neighborId: UUID }
}

slice "My Loans" {
  view My Loans from "Tool Added", "Neighbor Registered", "Tool Checked Out"
  ui Loans Screen @Neighbor
}
