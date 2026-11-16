# Payments test task: order service

A small order service for agent-driven payments. Prices come from the catalog, and an order's
status changes only from a verified provider notification.

## Run

    npm test          # 11 tests, Node 22.6+, no dependencies
    WEBHOOK_SECRET=whsec_xxx npm start

Endpoints: `GET /catalog`, `POST /orders {productId}`, `GET /orders/:id`, `POST /webhooks/stripe`.

## How it stays correct

- **Prices:** `POST /orders` reads only `productId`. The amount is copied from `src/catalog.ts`. Any price the caller (or an agent) sends is ignored.
- **Signatures:** the webhook is verified against the raw body with HMAC-SHA256 (Stripe's `t=...,v1=...` scheme), a 5 minute timestamp window and a constant-time compare. Failures return 400 and change nothing.
- **Duplicates:** each provider event id is processed once. A repeat returns 200 (so the provider stops retrying) and changes nothing.
- **State machine:** `pending -> paid | failed | needs_review`, `failed -> paid`, `paid -> refunded`. Anything else is ignored, so a late "failed" notice cannot undo a payment and a refund cannot happen before a payment.
- **Amounts:** a completed payment whose amount or currency differs from the catalog goes to `needs_review`, never `paid`.

## Results

| Case | What was sent | What happened to the order |
|---|---|---|
| Successful payment | signed `checkout.session.completed`, correct amount | `pending` -> `paid` |
| Declined payment | signed `payment_intent.payment_failed` | `pending` -> `failed` (never paid) |
| Repeated notification | same signed event twice | first: `paid`; second: 200, not applied; one `paid` entry in history |
| Repeated with new event id | second completed event, different id | not applied (`paid -> paid` is not allowed); one `paid` entry |
| Invalid signature | wrong secret / no header / body changed after signing | 400 each time; order stays `pending` |
| Stale signature | valid signature, timestamp 1 hour old | 400; order stays `pending` |
| Test refund | signed `charge.refunded` after payment | `paid` -> `refunded` |
| Refund before payment | signed `charge.refunded` on a pending order | ignored; stays `pending` |
| Late failure after payment | `payment_failed` after `completed` | ignored; stays `paid` |
| Amount mismatch | completed event for 100 cents on a 4500 cent order | `needs_review`, not `paid` |
| Price tampering | `POST /orders` with `priceCents: 1` | order created at the catalog price (2500) |

## What this does and does not cover

- `npm test` runs the logic locally against an in-memory store. `node scripts/live-test.mjs` runs the same cases against the **deployed** service (Supabase Edge Function + Postgres, Stripe test mode) and writes `RESULTS-live.md`.
- The live runner sends **locally signed events in Stripe's format**, signed with the real webhook secret. Orders are created through the real endpoint, which creates real Stripe test Checkout Sessions.
- Production behaviour: a primary key on the provider event id makes "process once" a database guarantee, and the status change, history row and event record happen in one transaction.
- Real card payments on Stripe's hosted page (test cards 4242... and 4000 0000 0000 0002) were run through the Agentplace agent. Those results, with the Stripe event ids, are in `RESULTS-live.md`.

## Deploy your own copy

1. Create a Supabase project and run `supabase/migrations/agentplace_test_schema.sql` (it creates a separate `agentplace_test` schema).
2. Set function secrets: `AGENTPLACE_STRIPE_SECRET_KEY`, `AGENTPLACE_STRIPE_WEBHOOK_SECRET`, `AGENTPLACE_ORDERS_API_KEY`.
3. Deploy: `supabase functions deploy agentplace-orders --no-verify-jwt --use-api --project-ref <ref>`.
4. In Stripe (test mode) add a webhook endpoint `https://<ref>.supabase.co/functions/v1/agentplace-orders/webhooks/stripe` for `checkout.session.completed`, `payment_intent.payment_failed` and `charge.refunded`, and put its signing secret in the webhook secret above.
5. Copy `.env.example` to `.env`, change `BASE` in `scripts/live-test.mjs` to your function URL, and run `node scripts/live-test.mjs`.

The agent calls `POST /orders` and `GET /orders/:id` with the `x-api-key` header. `GET /catalog` is open.
