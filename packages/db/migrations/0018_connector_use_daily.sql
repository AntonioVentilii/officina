-- A connector app's use is logged once a day per member and app. Checking for the day's row before
-- inserting let two token refreshes at the same moment both insert; this key makes the second one
-- a no-op. The day is UTC's, so it does not move with the session's time zone.
create unique index access_events_connector_use_daily on access_events
  (member_id, (detail ->> 'clientId'), ((created_at at time zone 'UTC')::date))
  where type = 'connector_used';
