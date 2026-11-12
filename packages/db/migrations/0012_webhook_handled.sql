-- A claimed delivery whose handler died (a crash, a deploy) was never given back, so a redelivery was
-- answered `duplicate` forever. Recording when a delivery was handled lets a claim left unhandled be
-- taken again, and each claim carries its own id, so a handler that outlived its claim cannot mark or
-- give back the claim that replaced it.
alter table webhook_deliveries
  add column handled_at timestamptz,
  add column claim uuid not null default gen_random_uuid();

-- Rows from before cannot tell a handled delivery from one whose handler died, so they stay unhandled:
-- GitHub redelivers only when a person asks, and every webhook effect is safe to apply twice (each
-- goes through the lifecycle's stage and head guards), so processing such a redelivery is the right
-- answer.
