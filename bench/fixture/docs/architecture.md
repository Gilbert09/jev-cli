# Architecture

Orders flow through `draft -> reserved -> paid -> shipped`. Cancellation is
permitted from any state before `shipped`.

Outbound calls (payments, mail, webhooks) all go through `withRetry` so the
retry policy is defined in exactly one place.
