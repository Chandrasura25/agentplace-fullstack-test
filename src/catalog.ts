// The catalog is the only source of prices. Nothing an agent or a client says can change them.
export type Product = { id: string; name: string; priceCents: number; currency: "usd" };

export const CATALOG: Record<string, Product> = {
  starter: { id: "starter", name: "Starter consultation (30 min)", priceCents: 2500, currency: "usd" },
  standard: { id: "standard", name: "Standard consultation (60 min)", priceCents: 4500, currency: "usd" },
  premium: { id: "premium", name: "Premium package (3 sessions)", priceCents: 11000, currency: "usd" },
};
