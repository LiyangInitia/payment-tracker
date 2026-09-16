-- Payment Request Tracker — initial schema.
--
-- This replaces a Claude Artifact that stored its rows as a JSON blob embedded
-- in the published HTML, rewritten in full on every sync cycle. Real rows in a
-- real table mean the sync script only ever touches the rows that changed.
--
-- request_message_id is the Gmail message id of the *original* payment-request
-- email (the thing the old artifact kept as "#all/<id>" inside emailUrl). It is
-- the true dedupe key: one row per outbound request message, never re-created.
create table if not exists payment_requests (
  id                bigint generated always as identity primary key,
  request_message_id text not null unique,
  request_thread_id  text not null,
  date_sent         date not null,
  vendor            text not null,
  vendor_full       text not null,
  description       text not null,
  entity            text not null,
  entity_full       text not null,
  amount            numeric(12,2) not null,
  currency          text not null,
  method            text not null,
  due_date          date not null,
  status            text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  payment_date      date,
  ref               text,
  email_url         text not null,
  slip_message_id   text,
  slip_url          text,
  notes             text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists payment_requests_status_idx on payment_requests (status);
create index if not exists payment_requests_due_date_idx on payment_requests (due_date);

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists payment_requests_set_updated_at on payment_requests;
create trigger payment_requests_set_updated_at
  before update on payment_requests
  for each row execute function set_updated_at();

-- RLS: the sync script writes with the service-role key, which bypasses RLS
-- entirely, so these policies only govern what the *browser* (anon key, signed
-- in via Supabase Auth) can do. Restricted to a single account rather than
-- "any authenticated user" since this is one person's accounts-payable data.
alter table payment_requests enable row level security;

create policy "liyang can read payment_requests"
  on payment_requests for select
  to authenticated
  using (auth.jwt() ->> 'email' = 'liyang@initia.sg');

create policy "liyang can edit payment_requests"
  on payment_requests for update
  to authenticated
  using (auth.jwt() ->> 'email' = 'liyang@initia.sg')
  with check (auth.jwt() ->> 'email' = 'liyang@initia.sg');

create policy "liyang can add payment_requests"
  on payment_requests for insert
  to authenticated
  with check (auth.jwt() ->> 'email' = 'liyang@initia.sg');

-- No delete policy: rows are cancelled, not deleted, matching the old artifact's
-- "never lose a row" safety rule.
