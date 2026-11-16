import { randomUUID } from "node:crypto";
import { CATALOG } from "./catalog.ts";

export type Status = "pending" | "paid" | "failed" | "refunded" | "needs_review";
export type Order = {
  id: string;
  productId: string;
  amountCents: number; // copied from the catalog at creation, never from the request
  currency: string;
  status: Status;
  history: { at: string; from: Status | null; to: Status; eventId: string | null; note: string }[];
};

export type ProviderEvent = {
  id: string;
  type: string;
  data: { object: { metadata?: { order_id?: string }; amount_total?: number; currency?: string } };
};

// Allowed transitions. Anything else is ignored, so a late or replayed
// notification can never move an order backwards (e.g. paid -> failed).
const ALLOWED: Record<Status, Status[]> = {
  pending: ["paid", "failed", "needs_review"],
  failed: ["paid"], // customer retries and pays successfully
  paid: ["refunded"],
  refunded: [],
  needs_review: [],
};

export type ApplyResult = { applied: boolean; reason: string };

export class OrderService {
  orders = new Map<string, Order>();
  processedEvents = new Set<string>();

  create(productId: string): Order {
    const p = CATALOG[productId];
    if (!p) throw new Error(`unknown product: ${productId}`);
    const order: Order = {
      id: randomUUID(),
      productId,
      amountCents: p.priceCents,
      currency: p.currency,
      status: "pending",
      history: [],
    };
    order.history.push({ at: new Date().toISOString(), from: null, to: "pending", eventId: null, note: "created from catalog price" });
    this.orders.set(order.id, order);
    return order;
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  list(limit = 50): Order[] {
    return [...this.orders.values()].reverse().slice(0, limit); // newest first
  }

  // Called only after the webhook signature has been verified.
  applyEvent(event: ProviderEvent): ApplyResult {
    if (this.processedEvents.has(event.id)) return { applied: false, reason: "duplicate event id, already processed" };

    const orderId = event.data?.object?.metadata?.order_id;
    const order = orderId ? this.orders.get(orderId) : undefined;
    this.processedEvents.add(event.id);
    if (!order) return { applied: false, reason: "no matching order" };

    let target: Status;
    let note: string = event.type;
    switch (event.type) {
      case "checkout.session.completed": {
        const o = event.data.object;
        if (o.amount_total !== order.amountCents || o.currency !== order.currency) {
          target = "needs_review";
          note = `amount mismatch: got ${o.amount_total} ${o.currency}, catalog says ${order.amountCents} ${order.currency}`;
        } else target = "paid";
        break;
      }
      case "payment_intent.payment_failed":
        target = "failed";
        break;
      case "charge.refunded":
        target = "refunded";
        break;
      default:
        return { applied: false, reason: `ignored event type ${event.type}` };
    }

    if (!ALLOWED[order.status].includes(target)) {
      return { applied: false, reason: `transition ${order.status} -> ${target} not allowed` };
    }
    const from = order.status;
    order.history.push({ at: new Date().toISOString(), from, to: target, eventId: event.id, note });
    order.status = target;
    return { applied: true, reason: `${from} -> ${target}` };
  }
}
