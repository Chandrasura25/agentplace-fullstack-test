// Order service for the Agentplace payments test task (Stripe test mode).
// Routes (under /functions/v1/agentplace-orders-fs):
//   GET  /catalog
//   GET  /orders?limit=50   (newest first, for the dashboard)
//   POST /orders            { productId }  -> order + Stripe Checkout test link
//   GET  /orders/:id
//   POST /webhooks/stripe   Stripe notifications (signature verified)
import postgres from "npm:postgres@3.4.5";

const CATALOG: Record<string, { name: string; priceCents: number; currency: string }> = {
  starter: { name: "Starter consultation (30 min)", priceCents: 2500, currency: "usd" },
  standard: { name: "Standard consultation (60 min)", priceCents: 4500, currency: "usd" },
  premium: { name: "Premium package (3 sessions)", priceCents: 11000, currency: "usd" },
};

const STRIPE_KEY = Deno.env.get("AGENTPLACE_STRIPE_SECRET_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("AGENTPLACE_STRIPE_WEBHOOK_SECRET") ?? "";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, prepare: false });

const ALLOWED: Record<string, string[]> = {
  pending: ["paid", "failed", "needs_review"],
  failed: ["paid"],
  paid: ["refunded"],
  refunded: [],
  needs_review: [],
};

// The dashboard is a separate origin, so it needs CORS. The API key still gates every route except /catalog and the webhook.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "x-api-key, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", ...CORS } });

// ---- signature (Stripe scheme: t=<unix>,v1=<hex hmac-sha256 of `${t}.${rawBody}`>) ----
const enc = new TextEncoder();
async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verify(raw: string, header: string | null, tolerance = 300): Promise<string | null> {
  if (!WEBHOOK_SECRET) return "webhook secret not configured";
  if (!header) return "missing signature header";
  let t = NaN;
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "t") t = Number(v);
    if (k === "v1") v1s.push(v);
  }
  if (!Number.isFinite(t) || v1s.length === 0) return "malformed signature header";
  if (Math.abs(Date.now() / 1000 - t) > tolerance) return "timestamp outside tolerance";
  const expected = await hmacHex(WEBHOOK_SECRET, `${t}.${raw}`);
  return v1s.some((v) => safeEqual(v, expected)) ? null : "signature mismatch";
}

// ---- order creation: price from the catalog only ----
async function createOrder(productId: string) {
  const p = CATALOG[productId];
  if (!p) return json(400, { error: `unknown product: ${productId}` });
  const [order] = await sql`
    insert into agentplace_fullstack.orders (product_id, amount_cents, currency)
    values (${productId}, ${p.priceCents}, ${p.currency}) returning *`;
  await sql`insert into agentplace_fullstack.order_history (order_id, from_status, to_status, note)
            values (${order.id}, null, 'pending', 'created from catalog price')`;

  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": p.currency,
    "line_items[0][price_data][unit_amount]": String(p.priceCents),
    "line_items[0][price_data][product_data][name]": p.name,
    "metadata[order_id]": order.id,
    "payment_intent_data[metadata][order_id]": order.id,
    success_url: "https://example.com/paid?order=" + order.id,
    cancel_url: "https://example.com/cancelled?order=" + order.id,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const session = await r.json();
  if (!r.ok) return json(502, { error: "stripe error", detail: session?.error?.message });
  await sql`update agentplace_fullstack.orders set stripe_session_id = ${session.id} where id = ${order.id}`;
  return json(201, { orderId: order.id, status: "pending", amountCents: p.priceCents, currency: p.currency, paymentLink: session.url });
}

// ---- webhook handling: one transaction, once per event id ----
async function applyEvent(event: any): Promise<{ applied: boolean; reason: string }> {
  return await sql.begin(async (tx) => {
    const inserted = await tx`
      insert into agentplace_fullstack.processed_events (event_id, event_type)
      values (${event.id}, ${event.type}) on conflict (event_id) do nothing returning event_id`;
    if (inserted.length === 0) return { applied: false, reason: "duplicate event id, already processed" };

    const obj = event.data?.object ?? {};
    let orderId: string | undefined = obj.metadata?.order_id;
    if (!orderId && event.type === "charge.refunded" && obj.payment_intent) {
      const [o] = await tx`select id from agentplace_fullstack.orders where stripe_payment_intent = ${obj.payment_intent}`;
      orderId = o?.id;
    }
    const finish = async (applied: boolean, reason: string) => {
      await tx`update agentplace_fullstack.processed_events set result = ${reason} where event_id = ${event.id}`;
      return { applied, reason };
    };
    if (!orderId) return await finish(false, "no matching order");

    const [order] = await tx`select * from agentplace_fullstack.orders where id = ${orderId}::uuid for update`;
    if (!order) return await finish(false, "no matching order");

    let target: string;
    let note: string = event.type;
    if (event.type === "checkout.session.completed") {
      const amountOk = obj.amount_total === order.amount_cents && obj.currency === order.currency;
      if (obj.payment_status !== "paid") return await finish(false, `payment_status is ${obj.payment_status}, not paid`);
      if (obj.payment_intent) {
        await tx`update agentplace_fullstack.orders set stripe_payment_intent = ${obj.payment_intent} where id = ${order.id}`;
      }
      if (!amountOk) {
        target = "needs_review";
        note = `amount mismatch: got ${obj.amount_total} ${obj.currency}, catalog says ${order.amount_cents} ${order.currency}`;
      } else target = "paid";
    } else if (event.type === "payment_intent.payment_failed") target = "failed";
    else if (event.type === "charge.refunded") target = "refunded";
    else return await finish(false, `ignored event type ${event.type}`);

    if (!ALLOWED[order.status].includes(target)) {
      return await finish(false, `transition ${order.status} -> ${target} not allowed`);
    }
    await tx`update agentplace_fullstack.orders set status = ${target}, updated_at = now() where id = ${order.id}`;
    await tx`insert into agentplace_fullstack.order_history (order_id, from_status, to_status, event_id, note)
             values (${order.id}, ${order.status}, ${target}, ${event.id}, ${note})`;
    return await finish(true, `${order.status} -> ${target}`);
  });
}

// Shared key for the agent's calls (x-api-key). The Stripe webhook does not use it; it is authenticated by signature.
const API_KEY = Deno.env.get("AGENTPLACE_ORDERS_API_KEY") ?? "";
function keyOk(req: Request): boolean {
  const given = req.headers.get("x-api-key") ?? "";
  return API_KEY.length >= 24 && safeEqual(given, API_KEY);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(functions\/v1\/)?agentplace-orders-fs/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method === "GET" && path === "/catalog") {
      return json(200, Object.entries(CATALOG).map(([id, p]) => ({ id, ...p })));
    }
    if (path !== "/webhooks/stripe" && !keyOk(req)) return json(401, { error: "missing or invalid x-api-key" });
    if (req.method === "POST" && path === "/orders") {
      // Only productId is read. Any price or amount in the body is ignored.
      const { productId } = await req.json().catch(() => ({}));
      return await createOrder(String(productId));
    }
    if (req.method === "GET" && path === "/orders") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
      const orders = await sql`select id, product_id, amount_cents, currency, status, created_at, updated_at
                               from agentplace_fullstack.orders order by created_at desc limit ${limit}`;
      return json(200, orders);
    }
    const m = path.match(/^\/orders\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && m) {
      const [order] = await sql`select id, product_id, amount_cents, currency, status, created_at, updated_at
                                from agentplace_fullstack.orders where id = ${m[1]}::uuid`;
      if (!order) return json(404, { error: "not found" });
      const history = await sql`select at, from_status, to_status, event_id, note
                                from agentplace_fullstack.order_history where order_id = ${m[1]}::uuid order by id`;
      return json(200, { ...order, history });
    }
    if (req.method === "POST" && path === "/webhooks/stripe") {
      const raw = await req.text(); // the signature covers these exact bytes
      const bad = await verify(raw, req.headers.get("stripe-signature"));
      if (bad) return json(400, { error: "invalid signature", reason: bad }); // no state change
      const result = await applyEvent(JSON.parse(raw));
      return json(200, { received: true, ...result }); // 200 on duplicates so Stripe stops retrying
    }
    return json(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "internal error" });
  }
});
