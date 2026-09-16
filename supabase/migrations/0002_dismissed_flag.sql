-- Supports the dashboard's "Delete request" action from the original artifact.
--
-- The original artifact did a true, permanent delete and relied on a separate
-- "seen message ids" localStorage set so its live Gmail-check would never
-- re-add a deleted row. This table has no such side channel: gmail-sync.mjs's
-- only dedupe key is "does a row with this request_message_id already exist".
-- A real SQL DELETE here would make a deleted row look brand-new to the very
-- next sync run (it's still within the 14-day search window) and resurrect it
-- within 30 minutes -- silently undoing the delete.
--
-- So "delete" in the UI sets this flag instead of removing the row. The row
-- stays in the table (sync's dedupe check still finds it, so it's never
-- resurrected) but is filtered out of every dashboard query.
alter table payment_requests add column if not exists dismissed boolean not null default false;

create index if not exists payment_requests_dismissed_idx on payment_requests (dismissed) where dismissed = false;
