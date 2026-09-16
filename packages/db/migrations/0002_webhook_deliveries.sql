-- GitHub redelivers webhooks; a delivery id that was already processed is acknowledged without effect.
create table webhook_deliveries (
  id text primary key,
  event text not null,
  received_at timestamptz not null default now()
);
