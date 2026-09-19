# orders-service

Internal service that accepts orders, reserves inventory, charges the customer,
and emits notifications.

## Layout

- `src/api/`       HTTP handlers
- `src/orders/`    order lifecycle
- `src/billing/`   charges, refunds, retries
- `src/inventory/` stock reservation
- `src/auth/`      tokens and sessions
- `src/notify/`    email and webhook delivery
- `src/util/`      shared helpers
- `src/generated/` produced by `npm run build` — safe to delete
- `dist/`          build output — safe to delete
- `local-data/`    developer scratch data, NOT in version control
