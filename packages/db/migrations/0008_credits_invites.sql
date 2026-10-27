-- Credit codes + invites. The credit_* and aff_* tables belong to
-- @profullstack/redeem-credits and @profullstack/affiliates (their postgres
-- stores create them; apps/web/src/credits.js warms them at boot). What a code
-- or invite grants is pro_days: days added to an org's org_billing.paid_through,
-- the same column a CoinPay payment extends.

-- The invite a signup carried, kept on the emailed link so opening it on
-- another device still counts. Accepted only when that link creates the account.
alter table login_tokens add column if not exists invite text;

-- One bonus per invited account, however often anything retries.
create table if not exists invite_bonuses (
  invitee_id    uuid primary key references users(id) on delete cascade,
  inviter_id    uuid not null references users(id) on delete cascade,
  invite_id     text not null,
  days          int not null,
  inviter_paid  boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists invite_bonuses_inviter_idx on invite_bonuses (inviter_id, created_at);
