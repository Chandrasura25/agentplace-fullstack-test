import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OrderService } from "../src/orders.ts";
import { buildServer } from "../src/server.ts";
import { sign } from "../src/signature.ts";

const SECRET = "whsec_test_secret";
const svc = new OrderService();
let server: Server;
let base: string;

before(async () => {
  server = buildServer(svc, SECRET);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function newOrder(productId = "standard", extra: object = {}) {
  const r = await fetch(`${base}/orders`, { method: "POST", body: JSON.stringify({ productId, ...extra }) });
  return (await r.json()).order as { id: string; amountCents: number; status: string };
}
const evt = (id: string, type: string, orderId: string, amount?: number) =>
  JSON.stringify({ id, type, data: { object: { metadata: { order_id: orderId }, amount_total: amount, currency: "usd" } } });
async function post(body: string, header?: string) {
  const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", body, headers: header ? { "stripe-signature": header } : {} });
  return { status: r.status, json: await r.json() };
}
const signed = (body: string) => post(body, sign(body, SECRET));
const status = async (id: string) => (await (await fetch(`${base}/orders/${id}`)).json()).status as string;

test("price comes from the catalog, not from the caller", async () => {
  const o = await newOrder("starter", { priceCents: 1, amountCents: 1, price: 0.01 });
  assert.equal(o.amountCents, 2500);
});

test("1. successful payment: pending -> paid", async () => {
  const o = await newOrder();
  assert.equal(o.status, "pending");
  const r = await signed(evt("evt_ok_1", "checkout.session.completed", o.id, 4500));
  assert.equal(r.status, 200);
  assert.equal(await status(o.id), "paid");
});

test("2. declined payment: pending -> failed, never paid", async () => {
  const o = await newOrder();
  await signed(evt("evt_decl_1", "payment_intent.payment_failed", o.id));
  assert.equal(await status(o.id), "failed");
});

test("3. repeated notification: same event twice changes nothing the second time", async () => {
  const o = await newOrder();
  const body = evt("evt_dup_1", "checkout.session.completed", o.id, 4500);
  const first = await signed(body);
  const second = await signed(body);
  assert.equal(first.json.applied, true);
  assert.equal(second.json.applied, false);
  assert.equal(second.status, 200); // still 200 so the provider stops retrying
  assert.equal(await status(o.id), "paid");
  assert.equal(svc.get(o.id)!.history.filter((h) => h.to === "paid").length, 1);
});

test("3b. a replay with a new event id cannot double count either", async () => {
  const o = await newOrder();
  await signed(evt("evt_dup_2a", "checkout.session.completed", o.id, 4500));
  const again = await signed(evt("evt_dup_2b", "checkout.session.completed", o.id, 4500));
  assert.equal(again.json.applied, false); // paid -> paid is not an allowed transition
  assert.equal(svc.get(o.id)!.history.filter((h) => h.to === "paid").length, 1);
});

test("4. invalid signature: rejected with 400, order unchanged", async () => {
  const o = await newOrder();
  const body = evt("evt_bad_1", "checkout.session.completed", o.id, 4500);
  assert.equal((await post(body, sign(body, "whsec_wrong_secret"))).status, 400); // wrong secret
  assert.equal((await post(body)).status, 400); // no header
  assert.equal((await post(body.replace("4500", "1"), sign(body, SECRET))).status, 400); // body changed after signing
  assert.equal(await status(o.id), "pending");
});

test("4b. stale timestamp is rejected (replay of an old signed request)", async () => {
  const o = await newOrder();
  const body = evt("evt_old_1", "checkout.session.completed", o.id, 4500);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await post(body, sign(body, SECRET, old))).status, 400);
  assert.equal(await status(o.id), "pending");
});

test("5. refund: paid -> refunded", async () => {
  const o = await newOrder();
  await signed(evt("evt_ref_pay", "checkout.session.completed", o.id, 4500));
  await signed(evt("evt_ref_1", "charge.refunded", o.id));
  assert.equal(await status(o.id), "refunded");
});

test("5b. refund for an order that was never paid is ignored", async () => {
  const o = await newOrder();
  const r = await signed(evt("evt_ref_2", "charge.refunded", o.id));
  assert.equal(r.json.applied, false);
  assert.equal(await status(o.id), "pending");
});

test("a late 'failed' notice cannot undo a payment", async () => {
  const o = await newOrder();
  await signed(evt("evt_late_pay", "checkout.session.completed", o.id, 4500));
  await signed(evt("evt_late_fail", "payment_intent.payment_failed", o.id));
  assert.equal(await status(o.id), "paid");
});

test("amount that does not match the catalog is held for review, not marked paid", async () => {
  const o = await newOrder();
  await signed(evt("evt_amt_1", "checkout.session.completed", o.id, 100));
  assert.equal(await status(o.id), "needs_review");
});

test("GET /orders lists orders newest first", async () => {
  const a = await newOrder();
  const b = await newOrder();
  const r = await fetch(`${base}/orders`);
  const list = (await r.json()) as { id: string }[];
  assert.equal(r.status, 200);
  assert.equal(list[0].id, b.id);
  assert.ok(list.some((o) => o.id === a.id));
});
