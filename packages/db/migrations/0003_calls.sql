-- AI phone calls on every appointment: a reminder before it and a follow-up after.
--
-- One row per (appointment, kind). The scheduler creates the rows, dials them when
-- due inside calling hours, and the Telnyx webhook writes back what happened.

-- Automated calls need the patient's prior consent (an AI voice is an "artificial
-- voice" under the TCPA). Recorded when the front desk books or the patient opts in;
-- cleared when they opt out on a call or in the portal.
alter table org_people add column call_consent_at timestamptz;
alter table org_people add column call_opt_out_at timestamptz;

create table org_call_settings (
  org_id                uuid primary key references organizations(id) on delete cascade,
  enabled               boolean not null default true,
  reminder_hours_before int not null default 24 check (reminder_hours_before between 1 and 168),
  followup_hours_after  int not null default 24 check (followup_hours_after between 1 and 168),
  call_window_start     int not null default 9 check (call_window_start between 0 and 23),  -- local hour
  call_window_end       int not null default 19 check (call_window_end between 1 and 24),
  max_attempts          int not null default 2 check (max_attempts between 1 and 5),
  updated_at            timestamptz not null default now()
);

create table calls (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  appointment_id   uuid not null references appointments(id) on delete cascade,
  patient_id       uuid not null references org_people(id) on delete cascade,
  kind             text not null check (kind in ('reminder', 'followup')),
  status           text not null default 'queued' check (status in
                     ('queued', 'dialing', 'in_progress', 'completed', 'no_answer', 'voicemail',
                      'failed', 'skipped', 'cancelled')),
  due_at           timestamptz not null,
  attempts         int not null default 0,
  next_attempt_at  timestamptz,
  to_number        text,
  call_control_id  text,
  -- What the call decided, as structured fields: confirmed, cancel, reschedule, question...
  outcome          jsonb,
  summary          text,      -- one line a human reads in the dashboard
  transcript       jsonb,     -- [{role, content}]
  flagged          boolean not null default false,
  flag_reason      text,
  resolved_at      timestamptz,
  resolved_by      uuid references org_people(id) on delete set null,
  skip_reason      text,
  last_error       text,
  started_at       timestamptz,
  ended_at         timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (appointment_id, kind)
);
create index calls_due_idx on calls (status, coalesce(next_attempt_at, due_at)) where status in ('queued', 'no_answer');
create index calls_org_idx on calls (org_id, created_at desc);
create index calls_flagged_idx on calls (org_id) where flagged and resolved_at is null;
create unique index calls_control_idx on calls (call_control_id) where call_control_id is not null;

-- Every dial, for the per-patient limits (one call a day, three a week).
create table call_attempts (
  id          bigserial primary key,
  call_id     uuid not null references calls(id) on delete cascade,
  patient_id  uuid not null references org_people(id) on delete cascade,
  at          timestamptz not null default now()
);
create index call_attempts_patient_idx on call_attempts (patient_id, at desc);
