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

# --- Read model the triage automation watches ---
slice "Triage Queue" {
  view Claims To Triage from "Claim Filed"
}

# --- Automation: triage new claims (reaction + command + event together) ---
slice "Assign Adjuster" {
  processor Triage Engine from "Claims To Triage"
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

# --- Read model the policy-admin translation watches ---
slice "Verify Coverage" {
  view Coverage Feed from "Claim Approved"
}

# --- Translation: external policy-admin coverage feed (reaction + command + event together) ---
slice "Confirm Coverage" {
  translation Policy Sync from "Coverage Feed"
  command Confirm Coverage
  event Coverage Confirmed @Policy
}

# --- Read model the payout automation watches ---
slice "Payout Queue" {
  view Confirmed Claims from "Coverage Confirmed"
}

# --- Automation: queue confirmed claims for payout (reaction + command + event together) ---
slice "Send Payment" {
  processor Payout Engine from "Confirmed Claims"
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
