-- Client-encrypted personal record vault. The API stores only the wrapped key
-- envelope and opaque ciphertext objects; filenames, record content, and MIME
-- types are encrypted by the client.

create table record_vault_keys (
  user_id       uuid primary key references users(id) on delete cascade,
  key_envelope  jsonb not null,
  key_check     text not null check (key_check ~ '^[A-Za-z0-9_-]{43}$'),
  format_version smallint not null default 1 check (format_version = 1),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table record_vault_objects (
  id             uuid primary key,
  user_id        uuid not null references record_vault_keys(user_id) on delete cascade,
  format_version smallint not null default 1 check (format_version = 1),
  ciphertext     bytea not null,
  size           int generated always as (octet_length(ciphertext)) stored,
  created_at     timestamptz not null default now(),
  unique (user_id, id),
  check (octet_length(ciphertext) between 28 and 104923168)
);

-- One encrypted index per account lets the client list opaque file objects
-- without exposing names, types, dates or categories to the server.
create table record_vault_manifests (
  user_id        uuid primary key references record_vault_keys(user_id) on delete cascade,
  revision       bigint not null default 1 check (revision > 0),
  format_version smallint not null default 1 check (format_version = 1),
  ciphertext     bytea not null,
  size           int generated always as (octet_length(ciphertext)) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (octet_length(ciphertext) between 28 and 10485760)
);

create index record_vault_objects_user_created_idx
  on record_vault_objects (user_id, created_at desc, id);
