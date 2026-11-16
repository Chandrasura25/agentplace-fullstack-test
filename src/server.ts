import { createServer } from "node:http";
import { OrderService, type ProviderEvent } from "./orders.ts";
import { verify } from "./signature.ts";
import { CATALOG } from "./catalog.ts";

export function buildServer(svc: OrderService, webhookSecret: string) {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "x-api-key, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8"); // raw body: the signature covers these exact bytes

    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/catalog") return send(200, Object.values(CATALOG));

      if (req.method === "POST" && url.pathname === "/orders") {
        // Only the product id is read. Any "price" or "amount" the caller sends is ignored.
        const { productId } = JSON.parse(raw || "{}");
        const order = svc.create(productId);
        const base = process.env.PAYMENT_LINK_BASE ?? "https://example.test/pay";
        return send(201, { order, paymentLink: `${base}/${order.id}` });
      }

      if (req.method === "GET" && url.pathname === "/orders") return send(200, svc.list());

      const m = url.pathname.match(/^\/orders\/([\w-]+)$/);
      if (req.method === "GET" && m) {
        const o = svc.get(m[1]);
        return o ? send(200, o) : send(404, { error: "not found" });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/stripe") {
        const v = verify(raw, req.headers["stripe-signature"] as string | undefined, webhookSecret);
        if (!v.ok) return send(400, { error: "invalid signature", reason: v.reason }); // no state change
        const result = svc.applyEvent(JSON.parse(raw) as ProviderEvent);
        return send(200, { received: true, ...result }); // 200 on duplicates so the provider stops retrying
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: (e as Error).message });
    }
  });
}

if (process.argv[1]?.endsWith("server.ts")) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("set WEBHOOK_SECRET");
  buildServer(new OrderService(), secret).listen(Number(process.env.PORT ?? 3000), () => console.log("listening"));
}
