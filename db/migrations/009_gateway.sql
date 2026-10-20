DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='pitlane_gateway') THEN CREATE ROLE pitlane_gateway NOLOGIN NOBYPASSRLS;END IF;END $$;
GRANT USAGE ON SCHEMA pitlane TO pitlane_gateway;
CREATE TABLE IF NOT EXISTS pitlane.provider_profiles(id text PRIMARY KEY,upstream_id text NOT NULL,network text NOT NULL,genesis text NOT NULL,maximum_micro bigint NOT NULL CHECK(maximum_micro>=0),calls_per_minute integer NOT NULL CHECK(calls_per_minute>0),enabled boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS pitlane.provider_windows(provider_id text REFERENCES pitlane.provider_profiles,window_start timestamptz,calls integer NOT NULL DEFAULT 0,PRIMARY KEY(provider_id,window_start));
ALTER TABLE pitlane.cost_intents ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
CREATE OR REPLACE FUNCTION pitlane.gateway_dispatch(j uuid,w text,e bigint,intent uuid,p text,m text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE v pitlane.cost_intents;profile pitlane.provider_profiles;win timestamptz=date_trunc('minute',clock_timestamp());n integer;
BEGIN PERFORM pitlane.leased_job(j,w,e);SELECT * INTO v FROM pitlane.cost_intents WHERE id=intent AND job_id=j AND lease_epoch=e AND provider_id=p AND method=m FOR UPDATE;
IF NOT FOUND OR v.dispatched_at IS NOT NULL THEN RAISE EXCEPTION 'INVALID_DISPATCH_INTENT';END IF;
SELECT * INTO profile FROM pitlane.provider_profiles WHERE id=p AND enabled;IF NOT FOUND OR profile.maximum_micro>v.maximum_micro THEN RAISE EXCEPTION 'UNPRICED_PROVIDER';END IF;
IF profile.network<>(SELECT input->>'network' FROM pitlane.jobs WHERE id=j) THEN RAISE EXCEPTION 'WRONG_PROVIDER_NETWORK';END IF;
INSERT INTO pitlane.provider_windows VALUES(p,win,0) ON CONFLICT DO NOTHING;SELECT calls INTO n FROM pitlane.provider_windows WHERE provider_id=p AND window_start=win FOR UPDATE;IF n>=profile.calls_per_minute THEN RAISE EXCEPTION 'PROVIDER_RATE_LIMIT';END IF;
UPDATE pitlane.provider_windows SET calls=calls+1 WHERE provider_id=p AND window_start=win;UPDATE pitlane.cost_intents SET dispatched_at=clock_timestamp() WHERE id=intent;END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.gateway_dispatch(uuid,text,bigint,uuid,text,text) TO pitlane_gateway;
