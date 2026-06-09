model "Insurance Claim"

persona Policyholder
persona Adjuster
persona Manager

context Claim
context Policy
context Payment

# --- Input: policyholder files a claim ---
slice "File Claim" {
  ui Claim Form @Policyholder
  command File Claim
  event Claim Filed @Claim
}

# --- Output: policyholder watches status ---
slice "Claim Status" {
  view Claim Status from "Claim Filed"
  ui Status Page @Policyholder
}

# --- Automation: triage new claims ---
slice "Triage Queue" {
  view Claims To Triage from "Claim Filed"
  processor Triage Engine
}

# --- Command (triggered): assign an adjuster ---
slice "Assign Adjuster" {
  command Assign Adjuster
  event Adjuster Assigned @Claim
}

# --- Output: adjuster worklist ---
slice "Adjuster Worklist" {
  view My Claims from "Adjuster Assigned"
  ui Adjuster Console @Adjuster
}

# --- Input: adjuster approves the claim ---
slice "Review Claim" {
  ui Review Screen @Adjuster
  command Approve Claim
  event Claim Approved @Claim
}

# --- Translation: external policy-admin coverage feed ---
slice "Verify Coverage" {
  view Coverage Feed from "Claim Approved"
  translation Policy Sync
}

# --- Command (triggered): confirm coverage ---
slice "Confirm Coverage" {
  command Confirm Coverage
  event Coverage Confirmed @Policy
}

# --- Automation: queue confirmed claims for payout ---
slice "Payout Queue" {
  view Confirmed Claims from "Coverage Confirmed"
  processor Payout Engine
}

# --- Command (triggered): send the payment ---
slice "Send Payment" {
  command Send Payment
  event Payment Sent @Payment
}

# --- Output: policyholder receipt ---
slice "Payment Confirmation" {
  view Payment Receipt from "Payment Sent"
  ui Receipt Page @Policyholder
}

# --- Output: manager dashboard (multi-source read model) ---
slice "Manager Dashboard" {
  view Claims Dashboard from "Claim Approved", "Payment Sent"
  ui Manager Console @Manager
}
