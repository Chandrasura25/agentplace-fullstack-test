-- Self-contained schema for the Agentplace Full-Stack test task (extended copy).
-- Lives in its own schema so it never touches the other projects.
create schema if not exists agentplace_fullstack;

create table if not exists agentplace_fullstack.orders (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null,
  status text not null default 'pending'
    check (status in ('pending','paid','failed','refunded','needs_review')),
  stripe_session_id text unique,
  stripe_payment_intent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agentplace_fullstack.order_history (
  id bigserial primary key,
  order_id uuid not null references agentplace_fullstack.orders(id),
  from_status text,
  to_status text not null,
  event_id text,
  note text,
  at timestamptz not null default now()
);

-- One row per provider event id. The primary key makes "process once" a database guarantee.
create table if not exists agentplace_fullstack.processed_events (
  event_id text primary key,
  event_type text not null,
  result text,
  processed_at timestamptz not null default now()
);

-- Not exposed through the REST API; only the Edge Function (server side) reads these.
alter table agentplace_fullstack.orders enable row level security;
alter table agentplace_fullstack.order_history enable row level security;
alter table agentplace_fullstack.processed_events enable row level security;
revoke all on schema agentplace_fullstack from anon, authenticated;
revoke all on all tables in schema agentplace_fullstack from anon, authenticated;
