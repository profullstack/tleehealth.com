-- Shared health tracker readings. The tracker encrypts a snapshot in the
-- browser under a one-time share passkey; the API stores only that ciphertext
-- and the passkey-wrapped key envelope. The passkey never reaches the server,
-- so neither the API nor the database can read a share.

create table health_shares (
  id             uuid primary key,
  user_id        uuid not null references users(id) on delete cascade,
  format_version smallint not null default 1 check (format_version = 1),
  key_envelope   jsonb not null,
  ciphertext     bytea not null,
  -- The owner's label (who it was shared with), sealed under the owner's own
  -- tracker key. Opaque to the server.
  label_sealed   bytea,
  size           int generated always as (octet_length(ciphertext)) stored,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  views          int not null default 0,
  last_viewed_at timestamptz,
  check (octet_length(ciphertext) between 28 and 2097152),
  check (label_sealed is null or octet_length(label_sealed) between 28 and 1024),
  check (expires_at > created_at)
);

create index health_shares_user_idx on health_shares (user_id, created_at desc);
create index health_shares_expires_idx on health_shares (expires_at);
