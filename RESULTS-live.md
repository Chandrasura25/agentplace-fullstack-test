# Live results (deployed service, Stripe test mode)

Run: 2026-11-16T13:41:19.338Z

| Case | What was sent | What happened to the order | Result |
|---|---|---|---|
| Price tampering | POST /orders with priceCents: 1 | order amount 2500 (catalog price 2500) | pass |
| 1. Successful payment | signed checkout.session.completed, 4500 usd | HTTP 200; paid (->pending, pending>paid) | pass |
| 2. Declined payment | signed payment_intent.payment_failed | HTTP 200; failed (->pending, pending>failed) | pass |
| 3. Repeated notification | same signed event sent twice | 1st applied=true; 2nd HTTP 200 applied=false (duplicate event id, already processed); paid, 1 paid entry | pass |
| 3b. Replay with a new event id | second completed event, different id | applied=false (transition paid -> paid not allowed); paid | pass |
| 4. Invalid signature | wrong secret / no header / body changed after signing | HTTP 400, 400, 400; order pending | pass |
| 4b. Stale timestamp | valid signature, 1 hour old | HTTP 400; order pending | pass |
| 5. Test refund | signed charge.refunded after payment | HTTP 200; refunded (->pending, pending>paid, paid>refunded) | pass |
| 5b. Refund with no matching payment | charge.refunded for an unknown payment intent | applied=false (no matching order); order pending | pass |
| Late failure after payment | payment_failed after completed | applied=false; paid | pass |
| Amount mismatch | completed for 100 on a 4500 order | needs_review | pass |
| Missing API key | POST /orders without x-api-key | HTTP 401 | pass |

12/12 passed.
