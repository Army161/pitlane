CREATE TABLE IF NOT EXISTS pitlane.login_requests(nonce_hash text PRIMARY KEY,email text NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',consumed boolean NOT NULL DEFAULT false);
CREATE OR REPLACE FUNCTION pitlane.begin_login(h text,address text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ INSERT INTO pitlane.login_requests(nonce_hash,email) VALUES(h,address) $$;
CREATE OR REPLACE FUNCTION pitlane.consume_login(h text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE address text;
BEGIN UPDATE pitlane.login_requests SET consumed=true WHERE nonce_hash=h AND NOT consumed AND expires_at>now() RETURNING email INTO address;IF NOT FOUND THEN RAISE EXCEPTION 'UNAUTHENTICATED';END IF;RETURN address;END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.begin_login(text,text),pitlane.consume_login(text) TO pitlane_auth;
