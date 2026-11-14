-- A retried connector call or a form sent twice would open the same request again, and start a
-- second paid interview. The client names each request it sends, and a repeat from the same
-- requester finds the task the first one opened instead.
alter table tasks add column request_id text;

create unique index tasks_by_request_id on tasks (project_id, requester_id, request_id)
  where request_id is not null;
