-- Health-record import: a patient connects their login at another provider
-- (MyChart and any other SMART on FHIR patient portal) and we copy everything it
-- will give us: demographics, visits, after-visit summaries, notes, labs, imaging,
-- medications, conditions, allergies, immunizations, procedures, and the files
-- (PDFs, images) those records point at.
--
-- The records belong to the ACCOUNT, not to a practice: a patient can import
-- without being anyone's patient, and shares a connection with a practice on
-- purpose (health_connection_shares).

create table health_connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  provider_name     text not null,
  vendor            text not null default 'smart',        -- epic, cerner, sandbox, smart
  fhir_base         text not null,
  token_endpoint    text,
  client_id         text,
  patient_ref       text,                                 -- the provider's FHIR Patient id
  scope             text,
  access_token      bytea,                                -- AES-256-GCM, see records.js
  refresh_token     bytea,
  token_expires_at  timestamptz,
  status            text not null default 'pending'
    check (status in ('pending', 'active', 'syncing', 'error', 'expired', 'revoked')),
  last_synced_at    timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index health_connections_user_idx on health_connections (user_id);

-- One row per sign-in attempt at a provider: the PKCE verifier and where to land.
create table health_connect_states (
  state          text primary key,
  user_id        uuid not null references users(id) on delete cascade,
  connection_id  uuid not null references health_connections(id) on delete cascade,
  verifier       text not null,
  return_to      text not null default 'portal',          -- portal | cli
  expires_at     timestamptz not null
);

create table health_records (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references health_connections(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  resource_type  text not null,
  resource_id    text not null,
  category       text not null,                           -- profile, visits, summaries, notes, labs, imaging, ...
  title          text,
  recorded_on    date,
  resource       jsonb not null,
  fetched_at     timestamptz not null default now(),
  unique (connection_id, resource_type, resource_id)
);
create index health_records_user_idx on health_records (user_id, category, recorded_on desc nulls last);

-- The attachments: after-visit summary PDFs, scanned notes, images, reports.
create table health_files (
  id             uuid primary key default gen_random_uuid(),
  record_id      uuid not null references health_records(id) on delete cascade,
  connection_id  uuid not null references health_connections(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  source_url     text not null,
  title          text,
  content_type   text,
  size           int not null,
  sha256         text not null,
  data           bytea not null,
  fetched_at     timestamptz not null default now(),
  unique (record_id, source_url)
);
create index health_files_user_idx on health_files (user_id);

-- A patient shows a connection's records to a practice they are a patient of.
create table health_connection_shares (
  connection_id  uuid not null references health_connections(id) on delete cascade,
  org_id         uuid not null references organizations(id) on delete cascade,
  patient_id     uuid not null references org_people(id) on delete cascade,
  shared_at      timestamptz not null default now(),
  primary key (connection_id, org_id)
);
create index health_connection_shares_patient_idx on health_connection_shares (patient_id);
