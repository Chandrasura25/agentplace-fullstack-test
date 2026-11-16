import { useCallback, useEffect, useState } from "react";
import { api, type Order, type OrderDetail, type Product, type Status } from "./api";

const KEY_STORE = "orders_api_key";
const money = (c: number, cur: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur.toUpperCase() }).format(c / 100);
const when = (iso: string) => new Date(iso).toLocaleString();
const LABEL: Record<Status, string> = { pending: "Pending", paid: "Paid", failed: "Failed", refunded: "Refunded", needs_review: "Needs review" };

function Badge({ s }: { s: Status }) {
  return <span className={`badge ${s}`}>{LABEL[s]}</span>;
}

function KeyGate({ onKey }: { onKey: (k: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="card gate"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onKey(v.trim());
      }}
    >
      <h1>Orders dashboard</h1>
      <p>
        Enter the orders API key. It stays in this tab only and is sent as <code>x-api-key</code>.
      </p>
      <input type="password" value={v} onChange={(e) => setV(e.target.value)} placeholder="API key" autoFocus />
      <button>Open</button>
    </form>
  );
}

function Detail({ k, id, onClose }: { k: string; id: string; onClose: () => void }) {
  const [o, setO] = useState<OrderDetail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setO(null);
    setErr("");
    api.get(k, id).then(setO).catch((e: Error) => setErr(e.message));
  }, [k, id]);
  return (
    <aside className="card detail">
      <button className="link" onClick={onClose}>
        Close
      </button>
      {err && <p className="err">{err}</p>}
      {!o && !err && <p>Loading...</p>}
      {o && (
        <>
          <h2>
            Order <code>{o.id.slice(0, 8)}</code> <Badge s={o.status} />
          </h2>
          <p>
            {o.product_id} · {money(o.amount_cents, o.currency)}
          </p>
          <ol className="timeline">
            {o.history.map((h, i) => (
              <li key={i}>
                <strong>{h.from_status ? `${LABEL[h.from_status]} → ${LABEL[h.to_status]}` : `Created (${LABEL[h.to_status]})`}</strong>
                <span>{when(h.at)}</span>
                <em>
                  {h.note}
                  {h.event_id ? ` · ${h.event_id}` : ""}
                </em>
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

function Dashboard({ k, onLogout }: { k: string; onLogout: () => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (e: Error) => {
      setErr(e.message);
      if (e.message === "Wrong API key") onLogout();
    },
    [onLogout],
  );
  const refresh = useCallback(
    () =>
      api
        .list(k)
        .then((o) => {
          setOrders(o);
          setErr("");
        })
        .catch(fail),
    [k, fail],
  );

  useEffect(() => {
    api
      .catalog(k)
      .then((p) => {
        setProducts(p);
        setPick(p[0]?.id ?? "");
      })
      .catch(fail);
    refresh();
    const t = setInterval(refresh, 5000); // statuses change when the Stripe webhook lands
    return () => clearInterval(t);
  }, [k, refresh, fail]);

  const create = async () => {
    setBusy(true);
    setLink("");
    try {
      const c = await api.create(k, pick);
      setLink(c.paymentLink);
      await refresh();
    } catch (e) {
      fail(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const shown = filter === "all" ? orders : orders.filter((o) => o.status === filter);
  const paidTotal = orders.filter((o) => o.status === "paid").reduce((n, o) => n + o.amount_cents, 0);
  const count = (s: Status | "all") => (s === "all" ? orders.length : orders.filter((o) => o.status === s).length);

  return (
    <main>
      <header>
        <h1>Orders</h1>
        <div>
          <span className="muted">Paid total {money(paidTotal, "usd")} · Stripe test mode</span>{" "}
          <button className="link" onClick={onLogout}>
            Lock
          </button>
        </div>
      </header>
      {err && <p className="err">{err}</p>}

      <section className="card row">
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {money(p.priceCents, p.currency)}
            </option>
          ))}
        </select>
        <button onClick={create} disabled={busy || !pick}>
          {busy ? "Creating..." : "Create test order"}
        </button>
        {link && (
          <a href={link} target="_blank" rel="noreferrer">
            Open Stripe test checkout ↗
          </a>
        )}
      </section>

      <nav className="filters">
        {(["all", "pending", "paid", "failed", "refunded", "needs_review"] as const).map((s) => (
          <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(s)}>
            {s === "all" ? "All" : LABEL[s]} ({count(s)})
          </button>
        ))}
      </nav>

      <div className="layout">
        <table className="card">
          <thead>
            <tr>
              <th>Order</th>
              <th>Product</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((o) => (
              <tr key={o.id} onClick={() => setOpen(o.id)} className={open === o.id ? "sel" : ""}>
                <td>
                  <code>{o.id.slice(0, 8)}</code>
                </td>
                <td>{o.product_id}</td>
                <td>{money(o.amount_cents, o.currency)}</td>
                <td>
                  <Badge s={o.status} />
                </td>
                <td>{when(o.updated_at)}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No orders here yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {open && <Detail k={k} id={open} onClose={() => setOpen(null)} />}
      </div>
    </main>
  );
}

export function App() {
  const [key, setKey] = useState(() => {
    try {
      return sessionStorage.getItem(KEY_STORE) ?? "";
    } catch {
      return "";
    }
  });
  const set = (k: string) => {
    setKey(k);
    try {
      if (k) sessionStorage.setItem(KEY_STORE, k);
      else sessionStorage.removeItem(KEY_STORE);
    } catch {
      /* storage blocked: the key lives in memory only */
    }
  };
  return key ? <Dashboard k={key} onLogout={() => set("")} /> : <KeyGate onKey={set} />;
}
