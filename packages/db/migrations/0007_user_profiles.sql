-- The shared Profullstack profile: email, first_name, last_name, company_domain,
-- job_title, linkedin_url, owned by @profullstack/profile.
--
-- The package's own table, keyed by users.id, so `profile export` and the store
-- work here with no options. DDL is `profile schema --key user_id --key-type uuid`
-- output. No foreign key, as the package documents; deleting a user is the host's job.
create table if not exists "user_profiles" (
  "user_id" uuid primary key,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "user_profiles_email" on "user_profiles" (lower("email"));
create index if not exists "user_profiles_company_domain" on "user_profiles" ("company_domain");

-- The account row is only created when the emailed link is spent, so the fields a
-- signup typed ride on the token until then. Validated before they are stored here,
-- and saved only once the link proves the mailbox: nobody can put a name on somebody
-- else's address by requesting a link for it.
alter table login_tokens add column if not exists profile jsonb;

-- One-time backfill from users.name (the name a person typed under Settings).
-- First word to first_name, the rest to last_name. Only blanks are filled, so a
-- re-run (or a profile somebody has since typed) is never overwritten.
insert into user_profiles (user_id, email, first_name, last_name)
select
  u.id,
  lower(u.email),
  split_part(btrim(u.name), ' ', 1),
  nullif(btrim(substr(btrim(u.name), length(split_part(btrim(u.name), ' ', 1)) + 1)), '')
from users u
where nullif(btrim(u.name), '') is not null
on conflict (user_id) do update set
  email      = coalesce(user_profiles.email, excluded.email),
  first_name = coalesce(user_profiles.first_name, excluded.first_name),
  last_name  = coalesce(user_profiles.last_name, excluded.last_name);
