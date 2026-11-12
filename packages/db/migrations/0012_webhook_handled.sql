-- A claimed delivery whose handler died (a crash, a deploy) was never given back, so a redelivery was
-- answered `duplicate` forever. Recording when a delivery was handled lets a claim left unhandled be
-- taken again.
alter table webhook_deliveries add column handled_at timestamptz;

-- Every delivery so far was either handled or given back.
update webhook_deliveries set handled_at = received_at;
