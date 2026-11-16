// Runs the five required cases (plus extras) against the DEPLOYED service.
// Events are signed locally with the real Stripe webhook secret from .env, in Stripe's format.
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const BASE = process.env.ORDERS_BASE; // e.g. https://<ref>.supabase.co/functions/v1/agentplace-orders-fs
if (!BASE) throw new Error("set ORDERS_BASE to this copy of the function (never the original deployment)");
const KEY = env.ORDERS_API_KEY, WHSEC = env.STRIPE_TEST_WEBHOOK_SECRET;

const sign = (body, secret = WHSEC, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const api = (path, init = {}) => fetch(BASE + path, { ...init, headers: { "x-api-key": KEY, "content-type": "application/json", ...(init.headers ?? {}) } });
const hook = async (body, header) => {
  const r = await fetch(`${BASE}/webhooks/stripe`, { method: "POST", body, headers: header ? { "stripe-signature": header } : {} });
  return { status: r.status, json: await r.json() };
};
const signedHook = (body) => hook(body, sign(body));
const uid = () => randomUUID().replace(/-/g, "").slice(0, 14);

async function newOrder(productId = "standard", extra = {}) {
  const r = await api("/orders", { method: "POST", body: JSON.stringify({ productId, ...extra }) });
  const j = await r.json();
  return { ...j, http: r.status };
}
const get = async (id) => (await (await api(`/orders/${id}`)).json());
const completed = (orderId, amount, pi, id = `evt_${uid()}`) =>
  JSON.stringify({ id, type: "checkout.session.completed", data: { object: { id: `cs_test_${uid()}`, payment_status: "paid", amount_total: amount, currency: "usd", payment_intent: pi, metadata: { order_id: orderId } } } });
const failed = (orderId, id = `evt_${uid()}`) =>
  JSON.stringify({ id, type: "payment_intent.payment_failed", data: { object: { id: `pi_${uid()}`, metadata: { order_id: orderId } } } });
const refunded = (pi, id = `evt_${uid()}`) =>
  JSON.stringify({ id, type: "charge.refunded", data: { object: { id: `ch_${uid()}`, payment_intent: pi, amount_refunded: 4500 } } });

const rows = [];
const record = (name, sent, outcome, pass) => { rows.push({ name, sent, outcome, pass }); console.log(pass ? "PASS" : "FAIL", "-", name, "->", outcome); };
const hist = (o) => o.history.map((h) => `${h.from_status ?? "-"}>${h.to_status}`).join(", ");

// 0. price comes from the catalog
{
  const o = await newOrder("starter", { priceCents: 1, amountCents: 1 });
  record("Price tampering", "POST /orders with priceCents: 1", `order amount ${o.amountCents} (catalog price 2500)`, o.amountCents === 2500);
}
// 1. success
{
  const o = await newOrder(); const pi = `pi_${uid()}`;
  const r = await signedHook(completed(o.orderId, 4500, pi));
  const g = await get(o.orderId);
  record("1. Successful payment", "signed checkout.session.completed, 4500 usd", `HTTP ${r.status}; ${g.status} (${hist(g)})`, g.status === "paid");
}
// 2. declined
{
  const o = await newOrder();
  const r = await signedHook(failed(o.orderId));
  const g = await get(o.orderId);
  record("2. Declined payment", "signed payment_intent.payment_failed", `HTTP ${r.status}; ${g.status} (${hist(g)})`, g.status === "failed");
}
// 3. repeated notification
{
  const o = await newOrder(); const body = completed(o.orderId, 4500, `pi_${uid()}`);
  const a = await signedHook(body), b = await signedHook(body);
  const g = await get(o.orderId);
  const paidRows = g.history.filter((h) => h.to_status === "paid").length;
  record("3. Repeated notification", "same signed event sent twice", `1st applied=${a.json.applied}; 2nd HTTP ${b.status} applied=${b.json.applied} (${b.json.reason}); ${g.status}, ${paidRows} paid entry`, a.json.applied && !b.json.applied && b.status === 200 && paidRows === 1);
}
// 3b. replay with new event id
{
  const o = await newOrder(); const pi = `pi_${uid()}`;
  await signedHook(completed(o.orderId, 4500, pi));
  const b = await signedHook(completed(o.orderId, 4500, pi));
  const g = await get(o.orderId);
  record("3b. Replay with a new event id", "second completed event, different id", `applied=${b.json.applied} (${b.json.reason}); ${g.status}`, !b.json.applied && g.status === "paid" && g.history.filter((h) => h.to_status === "paid").length === 1);
}
// 4. invalid signature
{
  const o = await newOrder(); const body = completed(o.orderId, 4500, `pi_${uid()}`);
  const wrong = await hook(body, sign(body, "whsec_wrong"));
  const none = await hook(body);
  const tampered = await hook(body.replace("4500", "1"), sign(body));
  const g = await get(o.orderId);
  record("4. Invalid signature", "wrong secret / no header / body changed after signing", `HTTP ${wrong.status}, ${none.status}, ${tampered.status}; order ${g.status}`, [wrong, none, tampered].every((x) => x.status === 400) && g.status === "pending");
}
// 4b. stale timestamp
{
  const o = await newOrder(); const body = completed(o.orderId, 4500, `pi_${uid()}`);
  const r = await hook(body, sign(body, WHSEC, Math.floor(Date.now() / 1000) - 3600));
  const g = await get(o.orderId);
  record("4b. Stale timestamp", "valid signature, 1 hour old", `HTTP ${r.status}; order ${g.status}`, r.status === 400 && g.status === "pending");
}
// 5. refund (charge event has no order metadata: matched through the payment intent)
{
  const o = await newOrder(); const pi = `pi_${uid()}`;
  await signedHook(completed(o.orderId, 4500, pi));
  const r = await signedHook(refunded(pi));
  const g = await get(o.orderId);
  record("5. Test refund", "signed charge.refunded after payment", `HTTP ${r.status}; ${g.status} (${hist(g)})`, g.status === "refunded");
}
// 5b. refund before payment
{
  const o = await newOrder();
  const r = await signedHook(refunded(`pi_${uid()}`));
  const g = await get(o.orderId);
  record("5b. Refund with no matching payment", "charge.refunded for an unknown payment intent", `applied=${r.json.applied} (${r.json.reason}); order ${g.status}`, !r.json.applied && g.status === "pending");
}
// extras
{
  const o = await newOrder(); const pi = `pi_${uid()}`;
  await signedHook(completed(o.orderId, 4500, pi));
  const r = await signedHook(failed(o.orderId));
  const g = await get(o.orderId);
  record("Late failure after payment", "payment_failed after completed", `applied=${r.json.applied}; ${g.status}`, !r.json.applied && g.status === "paid");
}
{
  const o = await newOrder();
  await signedHook(completed(o.orderId, 100, `pi_${uid()}`));
  const g = await get(o.orderId);
  record("Amount mismatch", "completed for 100 on a 4500 order", `${g.status}`, g.status === "needs_review");
}
{
  const r = await fetch(`${BASE}/orders`, { method: "POST", body: JSON.stringify({ productId: "starter" }) });
  record("Missing API key", "POST /orders without x-api-key", `HTTP ${r.status}`, r.status === 401);
}

const passed = rows.filter((r) => r.pass).length;
const md = `# Live results (deployed service, Stripe test mode)\n\nRun: ${new Date().toISOString()}\n\n| Case | What was sent | What happened to the order | Result |\n|---|---|---|---|\n` +
  rows.map((r) => `| ${r.name} | ${r.sent} | ${r.outcome} | ${r.pass ? "pass" : "FAIL"} |`).join("\n") + `\n\n${passed}/${rows.length} passed.\n`;
writeFileSync(new URL("../RESULTS-live.md", import.meta.url), md);
console.log(`\n${passed}/${rows.length} passed`);
process.exit(passed === rows.length ? 0 : 1);
