-- "Ask AI about my records", paid through the asker's own c0mpute.com account.
--
-- c0mpute_connections holds one connection per tleehealth user, bound to the
-- c0mpute ACCOUNT ID (never an email). The c0k_ key is sealed unlock-on-use
-- (token_sealed): the data key lives only in the running process for the time
-- the person picked, so nothing on disk can spend their balance.
--
-- Questions and answers are NOT stored. audit_log.detail records which records
-- were sent and the model, so a patient can see who asked about their records.

create table if not exists c0mpute_oauth_clients (
  redirect_uri  text not null,
  base_url      text not null,
  client_id     text not null,
  created_at    timestamptz not null default now(),
  primary key (redirect_uri, base_url)
);

create table if not exists c0mpute_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references users(id) on delete cascade,
  account_id    text not null unique,
  account_name  text,
  base_url      text not null,
  token_sealed  jsonb,
  status        text not null default 'active' check (status in ('active', 'invalid')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists c0mpute_connect_states (
  state         text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  verifier      text not null,
  client_id     text not null,
  redirect_uri  text not null,
  unlock_ttl    int,
  return_to     text not null default '/portal/records',
  expires_at    timestamptz not null
);

alter table audit_log add column if not exists detail jsonb;
