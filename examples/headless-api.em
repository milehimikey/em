model "Quote API"

persona IntegratorAPI   # every caller is programmatic — this lane stands in for API calls, not screens

context Quote

# --- State Change: the caller creates a quote (headless "trigger" = a `ui` under the API persona) ---
slice "Create Quote" {
  ui Create Quote @IntegratorAPI
  command Create Quote {
    accountId
    items: List<LineItem>
  }
  event Quote Created @Quote {
    quoteId
    accountId
    items: List<LineItem>
    createdAt: Instant
  }
}

# --- State View: the caller reads it back (headless "consumer" = a `ui` under the API persona) ---
slice "Quote — created" {
  view Quote from "Quote Created" {
    quoteId
    status
    items: List<LineItem>
  }
  ui Read Quote @IntegratorAPI
}

# --- Automation: fully internal, no public route, so no `ui` at all ---
slice "Quotes Pending Approval" {
  view Quotes Pending Approval from "Quote Created"
  processor Approval Router
}

slice "Escalate Quote" {
  command Escalate Quote
  event Quote Escalated @Quote {
    quoteId
    escalatedTo
    escalatedAt: Instant
  }
}

slice "Quote — escalated" {
  view Quote again from "Quote Escalated"
  ui Read Quote @IntegratorAPI
}

# --- Translation: a real external-system boundary, not a synchronous API call ---
slice "Pricing Engine Webhook" {
  translation Pricing Engine
}

slice "Apply Discount" {
  command Apply Discount
  event Discount Applied @Quote {
    quoteId
    discount: Money
  }
}

slice "Quote — discounted" {
  view Quote again from "Discount Applied"
  ui Read Quote @IntegratorAPI
}

# --- State Change: the caller accepts the quote ---
slice "Accept Quote" {
  ui Accept Quote @IntegratorAPI
  command Accept Quote
  event Quote Accepted @Quote {
    quoteId
    acceptedAt: Instant
  }
}

slice "Quote — accepted" {
  view Quote again from "Quote Accepted"
  ui Read Quote @IntegratorAPI
}
