-- Unlock-on-use (fleet rule, 2026-10-28): no key stored on our servers may open
-- a patient's portal tokens. They used to be AES-GCM under HEALTH_TOKEN_KEY
-- (app env). Now they are sealed under a per-connection data key that only the
-- running process holds while the patient's unlock lasts (token-vault.js):
-- tokens_sealed is ciphertext nothing on disk can open.
--
-- Prod had 0 health_connections rows when this shipped, so nothing migrates.
-- The legacy columns stay (never read) and refuse new values.

alter table health_connections
  add column if not exists tokens_sealed jsonb,
  add column if not exists seal_version int not null default 0;

alter table health_connections drop constraint if exists health_connections_status_check;
alter table health_connections add constraint health_connections_status_check
  check (status in ('pending', 'active', 'syncing', 'error', 'expired', 'revoked', 'locked'));

-- The unlock window the patient picked when connecting (seconds).
alter table health_connect_states add column if not exists unlock_ttl int;

create or replace function refuse_legacy_health_tokens() returns trigger language plpgsql as $$
begin
  if new.access_token is not null or new.refresh_token is not null then
    raise exception 'health_connections.access_token/refresh_token are legacy: tokens are stored sealed in tokens_sealed';
  end if;
  return new;
end;
$$;

drop trigger if exists refuse_legacy_health_tokens on health_connections;
create trigger refuse_legacy_health_tokens
  before insert or update of access_token, refresh_token on health_connections
  for each row execute function refuse_legacy_health_tokens();
