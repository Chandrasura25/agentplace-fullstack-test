# Note: how it fits together

## What I built

Two pieces on top of my earlier payments task, both separate from that submission:

- **An order service** (Supabase Edge Function + Postgres, Stripe test mode). Prices come from a server-side catalog. An order only changes status when a Stripe notification arrives with a valid signature, and each event id is processed once. Status moves are limited to a small set (`pending -> paid | failed | needs_review`, `failed -> paid`, `paid -> refunded`), so a late "failed" can't undo a payment.
- **A React + TypeScript dashboard** for whoever runs the business: order list, status filters, a timeline of each order's history, and a button that creates a test order with a Stripe test checkout link. It polls every 5 seconds, so you can watch a webhook change a status.
- **An Agentplace agent** (built on the free Luna model) that answers pricing questions from `GET /catalog` and looks up one order from `GET /orders/:id`.

The flow: the agent or dashboard creates an order -> Stripe checkout -> Stripe calls the webhook -> the function verifies the signature and updates Postgres in one transaction -> the dashboard and the agent read the new status.

## One decision worth explaining

The service has a `GET /orders` list endpoint, and the agent deliberately doesn't get it. The list is for the operator, behind the API key, in the dashboard. A customer-facing agent that could list orders could show one customer another customer's order. The builder raised the same concern on its own, and I removed the tool. I checked it on the published agent: asked for other customers' orders, it says it can't and offers an exact-ID lookup.

## What I'd change for production

- **Customer identity.** Right now anyone holding an order ID can read that order. IDs are random UUIDs, so they can't be guessed, but an ID is a bearer secret, not proof of ownership. I'd tie orders to a signed-in customer (or a signed, expiring link) and check ownership on every read.
- **Keys.** One shared API key does everything. I'd split it into read-only and write scopes, rotate it, and give the agent a key that can only read one order.
- **The dashboard.** It asks for the API key in the browser tab. Fine for a demo, but I'd put it behind a real login and keep the key on the server side.
- **CORS** is `*` so the dashboard can call the API. I'd restrict it to the dashboard's origin.
- **Abuse limits.** Rate limiting on the lookup and order-creation endpoints, and an expiry for unpaid pending orders.
- **Observability.** Logs and an alert for webhooks that fail verification or land in `needs_review`.
- **Migrations.** I applied the SQL by hand. I'd move to versioned migrations and a staging project.
- **Real card payments.** I tested the webhook rules with locally signed events and created real Stripe test checkout sessions. I haven't run a full card payment through this second copy; I did that in the first task.

## Where I hit limits on Agentplace

- **Secrets.** The builder won't take a secret from the chat (good), so I added the base URL and key in the environment settings by hand. That's the right call, but it means the agent can't be fully built from a description alone.
- **Speed.** Each build or change took several minutes, and the builder showed a temporary error mid-edit while an old test still referred to a tool I'd removed. It fixed itself, but I had to wait it out.
- **Testing what the builder reports.** It said the lookup failed with a generic "service could not complete the request" and hid the HTTP status. That is safe for customers but made it hard to tell a wrong key from a down service. I checked the endpoint directly to find out.
- **Anything beyond tools and chat.** The dashboard (a real UI with filters and polling) doesn't fit inside an Agentplace agent, so I built and deployed it separately. If I'd wanted it inside the platform, I'd need a way to embed a custom frontend.
