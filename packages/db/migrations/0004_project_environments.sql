-- Each project's agents run in their own sandbox environment, with that project's network allowances.
alter table projects add column agent_environment_id text;
