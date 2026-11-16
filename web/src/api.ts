export type Status = "pending" | "paid" | "failed" | "refunded" | "needs_review";
export type Order = {
  id: string;
  product_id: string;
  amount_cents: number;
  currency: string;
  status: Status;
  created_at: string;
  updated_at: string;
};
export type HistoryRow = { at: string; from_status: Status | null; to_status: Status; event_id: string | null; note: string };
export type OrderDetail = Order & { history: HistoryRow[] };
export type Product = { id: string; name: string; priceCents: number; currency: string };
export type Created = { orderId: string; status: Status; amountCents: number; currency: string; paymentLink: string };

const BASE = (import.meta.env.VITE_ORDERS_BASE as string | undefined)?.replace(/\/$/, "");

// The API key is typed in by the operator and kept in sessionStorage only.
// It is never bundled into the page, so the deployed site contains no secret.
async function call<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!BASE) throw new Error("VITE_ORDERS_BASE is not set");
  const r = await fetch(BASE + path, { ...init, headers: { "x-api-key": key, "content-type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "Wrong API key" : body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  catalog: (k: string) => call<Product[]>(k, "/catalog"),
  list: (k: string) => call<Order[]>(k, "/orders?limit=100"),
  get: (k: string, id: string) => call<OrderDetail>(k, `/orders/${id}`),
  // Only productId is sent. The server takes the price from its own catalog.
  create: (k: string, productId: string) => call<Created>(k, "/orders", { method: "POST", body: JSON.stringify({ productId }) }),
};
