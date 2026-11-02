-- CoinPay accounts are identified only by their stable provider subject. Its
-- email claim is unverified, so it must never be used to find or merge a user.
create table coinpay_identities (
  subject     text primary key,
  user_id     uuid not null unique references users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Short-lived, single-use OAuth state and PKCE verifier. The browser only gets
-- the random state; the verifier and any account-link target stay server-side.
create table coinpay_oauth_states (
  state_hash    bytea primary key,
  code_verifier text not null,
  user_id       uuid references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index coinpay_oauth_states_expires_idx on coinpay_oauth_states (expires_at);
