-- Durable, fenced provider inbox. Payload and scope remain immutable after ingestion.
ALTER TABLE pitlane.payment_inbox ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','retry','processed','quarantined'));
ALTER TABLE pitlane.payment_inbox ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE pitlane.payment_inbox ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pitlane.payment_inbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE pitlane.payment_inbox ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE pitlane.payment_inbox ADD COLUMN IF NOT EXISTS last_error text;
UPDATE pitlane.payment_inbox SET state='processed' WHERE processed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_inbox_pending ON pitlane.payment_inbox(available_at,received_at) WHERE processed_at IS NULL AND state<>'quarantined';
CREATE OR REPLACE FUNCTION pitlane.receive_payment_event(id text,account text,origin text,kind text,v jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE prior pitlane.payment_inbox;
BEGIN
 IF origin NOT IN('sandbox','live') OR id IS NULL OR length(id)>255 OR account IS NULL OR length(account)>255 OR kind IS NULL OR length(kind)>255 THEN RAISE EXCEPTION 'INVALID_PAYMENT_ENVIRONMENT';END IF;
 INSERT INTO pitlane.payment_inbox(event_id,provider_account,origin,event_type,payload) VALUES(id,account,origin,kind,v) ON CONFLICT DO NOTHING;
 IF FOUND THEN RETURN true;END IF;
 SELECT * INTO prior FROM pitlane.payment_inbox WHERE event_id=id;
 IF prior.provider_account<>account OR prior.origin<>origin OR prior.event_type<>kind OR prior.payload<>v THEN RAISE EXCEPTION 'PAYMENT_EVENT_IDENTITY_CONFLICT';END IF;
 RETURN false;
END $$;
CREATE OR REPLACE FUNCTION pitlane.claim_payment_events(kinds text[],maximum integer,account text,environment text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;
BEGIN
 UPDATE pitlane.payment_inbox SET state='quarantined',lease_until=NULL,last_error='PAYMENT_EVENT_RETRIES_EXHAUSTED' WHERE processed_at IS NULL AND attempts>=10 AND state<>'quarantined' AND (lease_until IS NULL OR lease_until<=clock_timestamp());
 WITH claimed AS(SELECT event_id FROM pitlane.payment_inbox WHERE processed_at IS NULL AND state<>'quarantined' AND attempts<10 AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (kinds IS NULL OR event_type=ANY(kinds)) AND (account IS NULL OR provider_account=account) AND origin=environment ORDER BY received_at,event_id FOR UPDATE SKIP LOCKED LIMIT greatest(0,least(maximum,100))),
 updated AS(UPDATE pitlane.payment_inbox SET state='processing',lease_until=clock_timestamp()+interval '30 seconds',lease_epoch=lease_epoch+1,attempts=attempts+1 WHERE event_id IN(SELECT event_id FROM claimed) RETURNING *)
 SELECT coalesce(jsonb_agg(updated),'[]'::jsonb) INTO result FROM updated;RETURN result;
END $$;
CREATE OR REPLACE FUNCTION pitlane.complete_payment_event(id text,epoch bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.payment_inbox SET processed_at=now(),state='processed',lease_until=NULL,last_error=NULL WHERE event_id=id AND state='processing' AND lease_epoch=epoch AND lease_until>clock_timestamp();IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;END $$;
CREATE OR REPLACE FUNCTION pitlane.fail_payment_event(id text,epoch bigint,code text,permanent boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.payment_inbox SET state=CASE WHEN permanent OR attempts>=10 THEN 'quarantined' ELSE 'retry' END,lease_until=NULL,available_at=clock_timestamp()+least(interval '1 hour',interval '30 seconds'*power(2,least(attempts-1,7))),last_error=CASE WHEN code~'^[A-Z_]{1,80}$' THEN code ELSE 'PROVIDER_RETRY_REQUIRED' END WHERE event_id=id AND state='processing' AND lease_epoch=epoch AND lease_until>clock_timestamp();IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;END $$;
-- Legacy readers cannot dispatch or complete unclaimed events.
CREATE OR REPLACE FUNCTION pitlane.payment_events(maximum integer) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM(SELECT * FROM pitlane.payment_inbox WHERE processed_at IS NULL AND state IN('pending','retry') AND available_at<=now() ORDER BY received_at LIMIT greatest(0,least(maximum,100))) e $$;
REVOKE EXECUTE ON FUNCTION pitlane.complete_payment_event(text) FROM pitlane_billing;

-- An authorization can arrive after a Checkout cancellation completed. Each newly
-- discovered provider intent gets a separate durable cancel operation.
CREATE OR REPLACE FUNCTION pitlane.order_authorized(target_id uuid,provider text,expiry timestamptz,amount bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;j pitlane.jobs;
BEGIN
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id;IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(o.tenant_id::text||o.project_id::text,0));SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;
 IF provider IS NULL OR amount<>o.amount_cents OR expiry IS NULL OR o.provider_id IS NOT NULL AND o.provider_id<>provider THEN RAISE EXCEPTION 'INVALID_AUTHORIZATION';END IF;
 IF o.state IN('authorized','delivered_pending_capture','settled','refunded','pending_reconciliation') THEN RETURN;END IF;
 UPDATE pitlane.orders SET provider_id=provider,capture_before=expiry WHERE id=target_id;
 IF o.hold_until<=clock_timestamp() OR o.state<>'awaiting_authorization' OR expiry<=clock_timestamp()+interval '180 seconds' OR NOT EXISTS(SELECT FROM pitlane.jobs WHERE order_id=target_id AND state='awaiting_payment' AND deadline>clock_timestamp()) THEN
  PERFORM pitlane.stop_order(target_id,CASE WHEN o.state='cancelled' THEN 'cancelled' ELSE 'authorization_expired' END);
  INSERT INTO pitlane.payment_outbox(tenant_id,order_id,business_key,operation) VALUES(o.tenant_id,target_id,target_id::text||'/cancel/'||provider,'cancel') ON CONFLICT DO NOTHING;RETURN;
 END IF;
 UPDATE pitlane.orders SET state='authorized' WHERE id=target_id;
 FOR j IN SELECT * FROM pitlane.jobs WHERE order_id=target_id AND state='awaiting_payment' LOOP UPDATE pitlane.jobs SET state='queued',deadline=clock_timestamp()+interval '180 seconds' WHERE id=j.id;PERFORM pitlane.emit(j.id,'queued');END LOOP;
END $$;
CREATE OR REPLACE FUNCTION pitlane.checkout_created(target_id uuid,checkout text,url text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE o pitlane.orders;
BEGIN
 SELECT * INTO o FROM pitlane.orders WHERE id=target_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF o.checkout_id IS NOT NULL AND o.checkout_id<>checkout THEN RAISE EXCEPTION 'PAYMENT_CHECKOUT_IDENTITY_CONFLICT';END IF;
 IF checkout IS NULL OR url IS NULL OR url!~'^https://checkout\.stripe\.com/' THEN RAISE EXCEPTION 'INVALID_CHECKOUT_URL';END IF;
 UPDATE pitlane.orders SET checkout_id=checkout,checkout_url=url WHERE id=target_id;
 IF o.state<>'awaiting_authorization' OR o.hold_until<=clock_timestamp() THEN INSERT INTO pitlane.payment_outbox(tenant_id,order_id,business_key,operation) VALUES(o.tenant_id,target_id,target_id::text||'/cancel/'||checkout,'cancel') ON CONFLICT DO NOTHING;END IF;
END $$;

CREATE TABLE IF NOT EXISTS pitlane.billing_catalog(
 provider_account text NOT NULL,origin text NOT NULL CHECK(origin IN('sandbox','live')),plan_id text NOT NULL,version text NOT NULL,label text NOT NULL,price_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),units integer NOT NULL CHECK(units BETWEEN 1 AND 10000),currency text NOT NULL CHECK(currency='usd'),interval text NOT NULL CHECK(interval='month'),
 PRIMARY KEY(provider_account,origin,plan_id,version),UNIQUE(provider_account,origin,price_id)
);
CREATE TABLE IF NOT EXISTS pitlane.billing_provider_configuration(id boolean PRIMARY KEY DEFAULT true CHECK(id),provider_account text NOT NULL,origin text NOT NULL CHECK(origin IN('sandbox','live')),environment_id text NOT NULL);
CREATE OR REPLACE FUNCTION pitlane.immutable_billing_catalog() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_BILLING_CATALOG';END $$;
CREATE TRIGGER billing_catalog_immutable BEFORE UPDATE OR DELETE ON pitlane.billing_catalog FOR EACH ROW EXECUTE FUNCTION pitlane.immutable_billing_catalog();
CREATE OR REPLACE FUNCTION pitlane.configure_billing_catalog(account text,environment text,plans jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE p jsonb;prior pitlane.billing_catalog;configured pitlane.billing_provider_configuration;environment_id text;
BEGIN
 IF account IS NULL OR account='' OR environment NOT IN('sandbox','live') OR jsonb_typeof(plans)<>'array' OR jsonb_array_length(plans)>32 THEN RAISE EXCEPTION 'INVALID_BILLING_CATALOG';END IF;
 SELECT runtime.environment_id INTO environment_id FROM pitlane.runtime;
 INSERT INTO pitlane.billing_provider_configuration VALUES(true,account,environment,environment_id) ON CONFLICT DO NOTHING;
 SELECT * INTO configured FROM pitlane.billing_provider_configuration;
 IF configured.provider_account<>account OR configured.origin<>environment OR configured.environment_id<>environment_id THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_ENVIRONMENT';END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(plans) LOOP
  INSERT INTO pitlane.billing_catalog VALUES(account,environment,p->>'planId',p->>'version',p->>'label',p->>'priceId',(p->>'amountCents')::bigint,(p->>'units')::integer,p->>'currency',p->>'interval') ON CONFLICT DO NOTHING;
  SELECT * INTO prior FROM pitlane.billing_catalog WHERE provider_account=account AND origin=environment AND plan_id=p->>'planId' AND version=p->>'version';
  IF NOT FOUND OR prior.label<>p->>'label' OR prior.price_id<>p->>'priceId' OR prior.amount_cents<>(p->>'amountCents')::bigint OR prior.units<>(p->>'units')::integer OR prior.currency<>p->>'currency' OR prior.interval<>p->>'interval' THEN RAISE EXCEPTION 'IMMUTABLE_BILLING_CATALOG';END IF;
 END LOOP;
END $$;
ALTER TABLE pitlane.billing_customers ADD COLUMN IF NOT EXISTS provider_account text;
ALTER TABLE pitlane.billing_subscriptions ADD COLUMN IF NOT EXISTS provider_account text;
ALTER TABLE pitlane.billing_subscriptions ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE pitlane.billing_subscriptions ADD COLUMN IF NOT EXISTS plan_id text;
ALTER TABLE pitlane.billing_subscriptions ADD COLUMN IF NOT EXISTS price_id text;
ALTER TABLE pitlane.billing_subscriptions ADD COLUMN IF NOT EXISTS restricted boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS pitlane.subscription_purchases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES pitlane.tenants,request_key text NOT NULL,provider_account text NOT NULL,origin text NOT NULL CHECK(origin IN('sandbox','live')),plan_id text NOT NULL,plan_version text NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN('requested','awaiting_checkout','linked','expired','failed')),provider_customer_id text,checkout_id text UNIQUE,checkout_url text,provider_subscription_id text UNIQUE,
 hold_until timestamptz NOT NULL DEFAULT now()+interval '30 minutes',attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,lease_epoch bigint NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(provider_account,origin,plan_id,plan_version) REFERENCES pitlane.billing_catalog(provider_account,origin,plan_id,version)
);
ALTER TABLE pitlane.subscription_purchases ADD COLUMN IF NOT EXISTS customer_attempted boolean NOT NULL DEFAULT false;
ALTER TABLE pitlane.subscription_purchases ADD COLUMN IF NOT EXISTS checkout_attempted boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION pitlane.subscription_external_attempt(target uuid,epoch bigint,phase text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE r pitlane.subscription_purchases;prior boolean;
BEGIN SELECT * INTO r FROM pitlane.subscription_purchases WHERE id=target AND state='requested' AND lease_epoch=epoch AND lease_until>clock_timestamp() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;IF phase NOT IN('customer','checkout') THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;prior=CASE WHEN phase='customer' THEN r.customer_attempted ELSE r.checkout_attempted END;UPDATE pitlane.subscription_purchases SET customer_attempted=customer_attempted OR phase='customer',checkout_attempted=checkout_attempted OR phase='checkout' WHERE id=target;RETURN prior;END $$;
ALTER TABLE pitlane.subscription_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_purchase_read ON pitlane.subscription_purchases FOR SELECT USING(pitlane.can_billing(tenant_id));
ALTER TABLE pitlane.billing_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_catalog_read ON pitlane.billing_catalog FOR SELECT USING(pitlane.can_billing(pitlane.actor_tenant()));
CREATE OR REPLACE FUNCTION pitlane.subscription_plans() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN IF NOT pitlane.can_billing(pitlane.actor_tenant()) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;RETURN(SELECT coalesce(jsonb_agg(jsonb_build_object('planId',plan_id,'version',version,'label',label,'amountCents',amount_cents::text,'units',units,'currency',currency,'interval',interval) ORDER BY amount_cents,plan_id,version),'[]'::jsonb) FROM pitlane.billing_catalog WHERE origin=(SELECT billing_mode FROM pitlane.runtime) AND provider_account=(SELECT provider_account FROM pitlane.billing_provider_configuration));END $$;
CREATE OR REPLACE FUNCTION pitlane.purchase_subscription(plan text,version text,k text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();p pitlane.billing_catalog;r pitlane.subscription_purchases;
BEGIN
 IF NOT pitlane.can_billing(t) THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF k IS NULL OR length(k)<16 OR length(k)>128 THEN RAISE EXCEPTION 'INVALID_INPUT';END IF;
 IF (SELECT billing_mode FROM pitlane.runtime)='disabled' THEN RAISE EXCEPTION 'BILLING_DISABLED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('subscription/'||t::text,0));
 SELECT * INTO r FROM pitlane.subscription_purchases WHERE tenant_id=t AND request_key=k;
 IF FOUND THEN IF r.plan_id<>plan OR r.plan_version<>version THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;RETURN to_jsonb(r);END IF;
 SELECT * INTO p FROM pitlane.billing_catalog WHERE plan_id=plan AND billing_catalog.version=purchase_subscription.version AND origin=(SELECT billing_mode FROM pitlane.runtime) AND provider_account=(SELECT provider_account FROM pitlane.billing_provider_configuration);
 IF NOT FOUND THEN RAISE EXCEPTION 'UNSUPPORTED_SUBSCRIPTION_PLAN';END IF;
 IF EXISTS(SELECT FROM pitlane.subscription_purchases WHERE tenant_id=t AND state IN('requested','awaiting_checkout','linked')) THEN RAISE EXCEPTION 'SUBSCRIPTION_ALREADY_EXISTS';END IF;
 INSERT INTO pitlane.subscription_purchases(tenant_id,request_key,provider_account,origin,plan_id,plan_version) VALUES(t,k,p.provider_account,p.origin,p.plan_id,p.version) RETURNING * INTO r;RETURN to_jsonb(r);
END $$;
CREATE OR REPLACE FUNCTION pitlane.subscription_purchase_status(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE r pitlane.subscription_purchases;BEGIN SELECT * INTO r FROM pitlane.subscription_purchases WHERE id=target AND tenant_id=pitlane.actor_tenant() AND pitlane.can_billing(tenant_id);IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;RETURN to_jsonb(r);END $$;
CREATE OR REPLACE FUNCTION pitlane.claim_subscription_purchases(account text,environment text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;BEGIN WITH selected AS(SELECT id FROM pitlane.subscription_purchases WHERE provider_account=account AND origin=environment AND state='requested' AND available_at<=now() AND attempts<10 AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1),updated AS(UPDATE pitlane.subscription_purchases SET attempts=attempts+1,lease_epoch=lease_epoch+1,lease_until=now()+interval '30 seconds' WHERE id IN(SELECT id FROM selected) RETURNING *) SELECT coalesce(jsonb_agg(to_jsonb(u)||jsonb_build_object('catalog',to_jsonb(c))),'[]'::jsonb) INTO result FROM updated u JOIN pitlane.billing_catalog c ON c.provider_account=u.provider_account AND c.origin=u.origin AND c.plan_id=u.plan_id AND c.version=u.plan_version;RETURN result;END $$;
CREATE OR REPLACE FUNCTION pitlane.billing_customer(t uuid,account text,environment text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(c) FROM pitlane.billing_customers c WHERE tenant_id=t AND provider_account=account AND origin=environment $$;
CREATE OR REPLACE FUNCTION pitlane.link_billing_customer(t uuid,customer text,account text,environment text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE prior pitlane.billing_customers;BEGIN INSERT INTO pitlane.billing_customers VALUES(t,customer,environment,account) ON CONFLICT DO NOTHING;SELECT * INTO prior FROM pitlane.billing_customers WHERE tenant_id=t;IF prior.provider_customer_id<>customer OR prior.provider_account<>account OR prior.origin<>environment THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;END $$;
CREATE OR REPLACE FUNCTION pitlane.subscription_checkout_created(target uuid,epoch bigint,customer text,checkout text,url text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.subscription_purchases SET state='awaiting_checkout',provider_customer_id=customer,checkout_id=checkout,checkout_url=url,lease_until=NULL,last_error=NULL WHERE id=target AND state='requested' AND lease_epoch=epoch AND lease_until>clock_timestamp();IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;IF url!~'^https://checkout\.stripe\.com/' THEN RAISE EXCEPTION 'INVALID_CHECKOUT_URL';END IF;END $$;
CREATE OR REPLACE FUNCTION pitlane.fail_subscription_purchase(target uuid,epoch bigint,code text,permanent boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.subscription_purchases SET state=CASE WHEN permanent OR attempts>=10 OR hold_until<=now() THEN 'failed' ELSE 'requested' END,lease_until=NULL,available_at=now()+interval '30 seconds',last_error=CASE WHEN code~'^[A-Z_]{1,80}$' THEN code ELSE 'PROVIDER_RETRY_REQUIRED' END WHERE id=target AND state='requested' AND lease_epoch=epoch AND lease_until>clock_timestamp();IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;END $$;
CREATE OR REPLACE FUNCTION pitlane.subscription_for_checkout(checkout text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(r)||jsonb_build_object('catalog',to_jsonb(c)) FROM pitlane.subscription_purchases r JOIN pitlane.billing_catalog c ON c.provider_account=r.provider_account AND c.origin=r.origin AND c.plan_id=r.plan_id AND c.version=r.plan_version WHERE r.checkout_id=checkout $$;
CREATE OR REPLACE FUNCTION pitlane.trust_subscription_checkout(target uuid,customer text,subscription text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE r pitlane.subscription_purchases;
BEGIN SELECT * INTO r FROM pitlane.subscription_purchases WHERE id=target FOR UPDATE;IF NOT FOUND OR r.provider_customer_id<>customer OR r.state NOT IN('awaiting_checkout','linked') THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;
 IF r.provider_subscription_id IS NOT NULL AND r.provider_subscription_id<>subscription THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;
 INSERT INTO pitlane.billing_subscriptions(provider_subscription_id,tenant_id,provider_customer_id,plan_version,provider_account,origin,plan_id,price_id) SELECT subscription,r.tenant_id,customer,r.plan_version,r.provider_account,r.origin,r.plan_id,c.price_id FROM pitlane.billing_catalog c WHERE c.provider_account=r.provider_account AND c.origin=r.origin AND c.plan_id=r.plan_id AND c.version=r.plan_version ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT FROM pitlane.billing_subscriptions WHERE provider_subscription_id=subscription AND tenant_id=r.tenant_id AND provider_customer_id=customer AND provider_account=r.provider_account AND origin=r.origin AND plan_version=r.plan_version AND plan_id=r.plan_id) THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;
 UPDATE pitlane.subscription_purchases SET state='linked',provider_subscription_id=subscription WHERE id=target;
END $$;
CREATE OR REPLACE FUNCTION pitlane.subscription_link(sub text,customer text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(s)||jsonb_build_object('catalog',to_jsonb(c)) FROM pitlane.billing_subscriptions s JOIN pitlane.billing_catalog c ON c.provider_account=s.provider_account AND c.origin=s.origin AND c.plan_id=s.plan_id AND c.version=s.plan_version WHERE s.provider_subscription_id=sub AND s.provider_customer_id=customer $$;
CREATE OR REPLACE FUNCTION pitlane.expire_subscription_checkout(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ UPDATE pitlane.subscription_purchases SET state='expired' WHERE id=target AND state='awaiting_checkout' $$;
CREATE OR REPLACE FUNCTION pitlane.expiring_subscription_checkouts(account text,environment text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT coalesce(jsonb_agg(r),'[]'::jsonb) FROM(SELECT * FROM pitlane.subscription_purchases WHERE provider_account=account AND origin=environment AND state='awaiting_checkout' AND hold_until<=now() ORDER BY created_at LIMIT 10) r $$;

-- Provider-confirmed monetary adjustments share a capped settlement record.
CREATE TABLE IF NOT EXISTS pitlane.payment_settlements(
 provider_payment_id text PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES pitlane.tenants,order_id uuid REFERENCES pitlane.orders,invoice_id text UNIQUE,subscription_id text,
 origin text NOT NULL CHECK(origin IN('sandbox','live','fixture')),provider_account text,amount_cents bigint NOT NULL CHECK(amount_cents>=0),refunded_cents bigint NOT NULL DEFAULT 0,disputed_cents bigint NOT NULL DEFAULT 0,
 CHECK(refunded_cents>=0 AND disputed_cents>=0 AND refunded_cents+disputed_cents<=amount_cents)
);
CREATE TABLE IF NOT EXISTS pitlane.payment_adjustments(
 provider_adjustment_id text PRIMARY KEY,provider_payment_id text NOT NULL REFERENCES pitlane.payment_settlements,kind text NOT NULL CHECK(kind IN('refund','dispute')),requested_cents bigint NOT NULL CHECK(requested_cents>0),applied_cents bigint NOT NULL CHECK(applied_cents>=0),state text NOT NULL CHECK(state IN('confirmed','released')),business_key text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION pitlane.record_order_settlement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE environment text;
BEGIN IF NEW.provider_id IS NOT NULL AND NEW.settled_cents>0 THEN SELECT CASE WHEN mode='local' THEN 'fixture' ELSE billing_mode END INTO environment FROM pitlane.runtime;INSERT INTO pitlane.payment_settlements(provider_payment_id,tenant_id,order_id,origin,amount_cents,refunded_cents) VALUES(NEW.provider_id,NEW.tenant_id,NEW.id,environment,NEW.settled_cents,NEW.refunded_cents) ON CONFLICT(provider_payment_id) DO UPDATE SET refunded_cents=NEW.refunded_cents;END IF;RETURN NEW;END $$;
CREATE TRIGGER order_settlement_record AFTER UPDATE OF settled_cents,refunded_cents ON pitlane.orders FOR EACH ROW EXECUTE FUNCTION pitlane.record_order_settlement();
INSERT INTO pitlane.payment_settlements(provider_payment_id,tenant_id,order_id,origin,amount_cents,refunded_cents)
 SELECT o.provider_id,o.tenant_id,o.id,j.origin,o.settled_cents,o.refunded_cents FROM pitlane.orders o JOIN pitlane.journals j ON j.source_key=o.id::text||'/capture' WHERE o.provider_id IS NOT NULL AND o.settled_cents>0 AND j.origin IN('fixture','sandbox','live') ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION pitlane.subscription_settle_verified(invoice text,subscription text,customer text,price text,period_start timestamptz,period_end timestamptz,paid bigint,payment text,account text,environment text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE s pitlane.billing_subscriptions;c pitlane.billing_catalog;prior pitlane.payment_settlements;
BEGIN
 SELECT * INTO s FROM pitlane.billing_subscriptions WHERE provider_subscription_id=subscription AND provider_customer_id=customer AND provider_account=account AND origin=environment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'UNRELATED_SUBSCRIPTION';END IF;
 SELECT * INTO c FROM pitlane.billing_catalog WHERE provider_account=account AND origin=environment AND plan_id=s.plan_id AND version=s.plan_version AND price_id=price;
 IF NOT FOUND OR c.amount_cents<>paid OR period_end<=period_start OR payment IS NULL THEN RAISE EXCEPTION 'INVALID_SETTLEMENT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('invoice/'||invoice,0));
 SELECT * INTO prior FROM pitlane.payment_settlements WHERE invoice_id=invoice OR provider_payment_id=payment;
 IF FOUND THEN IF prior.invoice_id<>invoice OR prior.provider_payment_id<>payment OR prior.tenant_id<>s.tenant_id OR prior.amount_cents<>paid OR prior.origin<>environment OR prior.provider_account<>account THEN RAISE EXCEPTION 'PAYMENT_SETTLEMENT_IDENTITY_CONFLICT';END IF;RETURN;END IF;
 PERFORM pitlane.subscription_settle(invoice,s.tenant_id,subscription,c.units,period_start,period_end,paid,environment);
 IF s.restricted THEN UPDATE pitlane.entitlement_lots SET ends_at=least(ends_at,now()) WHERE source_key='invoice/'||invoice;END IF;
 INSERT INTO pitlane.payment_settlements(provider_payment_id,tenant_id,invoice_id,subscription_id,origin,provider_account,amount_cents) VALUES(payment,s.tenant_id,invoice,subscription,environment,account,paid);
END $$;
REVOKE EXECUTE ON FUNCTION pitlane.subscription_settle(text,uuid,text,integer,timestamptz,timestamptz,bigint,text) FROM pitlane_billing;
CREATE OR REPLACE FUNCTION pitlane.payment_settlement(payment text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ SELECT to_jsonb(s) FROM pitlane.payment_settlements s WHERE provider_payment_id=payment $$;
CREATE OR REPLACE FUNCTION pitlane.restrict_subscription(subscription text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.billing_subscriptions SET restricted=true WHERE provider_subscription_id=subscription;UPDATE pitlane.entitlement_lots SET ends_at=least(ends_at,now()) WHERE source_key IN(SELECT 'invoice/'||invoice_id FROM pitlane.payment_settlements WHERE subscription_id=subscription);END $$;
CREATE TABLE IF NOT EXISTS pitlane.payment_adjustment_aliases(provider_adjustment_id text PRIMARY KEY,local_adjustment_id text NOT NULL REFERENCES pitlane.payment_adjustments);
CREATE UNIQUE INDEX IF NOT EXISTS payment_adjustment_business_key ON pitlane.payment_adjustments(business_key) WHERE business_key IS NOT NULL;
INSERT INTO pitlane.payment_adjustments(provider_adjustment_id,provider_payment_id,kind,requested_cents,applied_cents,state,business_key)
 SELECT 'local/'||op.id::text,s.provider_payment_id,'refund',r.amount_cents,r.amount_cents,'confirmed',op.business_key FROM pitlane.refund_requests r JOIN pitlane.payment_outbox op ON op.order_id=r.order_id AND op.business_key=r.order_id::text||'/refund/'||r.id::text JOIN pitlane.payment_settlements s ON s.order_id=r.order_id JOIN pitlane.journals j ON j.source_key=op.business_key WHERE r.state='settled' ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION pitlane.guard_refund_available() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE s pitlane.payment_settlements;pending bigint;
BEGIN SELECT * INTO s FROM pitlane.payment_settlements WHERE order_id=NEW.order_id FOR UPDATE;IF FOUND THEN SELECT coalesce(sum(amount_cents),0) INTO pending FROM pitlane.refund_requests WHERE order_id=NEW.order_id AND state IN('requested','pending_reconciliation');IF NEW.amount_cents+pending>s.amount_cents-s.refunded_cents-s.disputed_cents THEN RAISE EXCEPTION 'REFUND_EXCEEDS_SETTLEMENT';END IF;END IF;RETURN NEW;END $$;
CREATE TRIGGER refund_available BEFORE INSERT ON pitlane.refund_requests FOR EACH ROW EXECUTE FUNCTION pitlane.guard_refund_available();
-- Recompute monetary exposure from confirmed objects, giving actual refunds
-- priority over overlapping disputed funds. Append only the net/reclassification
-- journal; a won dispute can never restore money that was actually refunded.
CREATE OR REPLACE FUNCTION pitlane.rebalance_payment_adjustments(payment text,source text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE s pitlane.payment_settlements;refunds bigint;disputes bigint;refund_delta bigint;dispute_delta bigint;journal uuid;
BEGIN
 SELECT * INTO s FROM pitlane.payment_settlements WHERE provider_payment_id=payment FOR UPDATE;
 SELECT least(s.amount_cents,coalesce(sum(requested_cents) FILTER(WHERE kind='refund' AND state='confirmed'),0)) INTO refunds FROM pitlane.payment_adjustments WHERE provider_payment_id=payment;
 SELECT least(s.amount_cents-refunds,coalesce(sum(requested_cents) FILTER(WHERE kind='dispute' AND state='confirmed'),0)) INTO disputes FROM pitlane.payment_adjustments WHERE provider_payment_id=payment;
 refund_delta=refunds-s.refunded_cents;dispute_delta=disputes-s.disputed_cents;
 INSERT INTO pitlane.journals(tenant_id,source_key,origin) VALUES(s.tenant_id,source,s.origin) RETURNING id INTO journal;
 INSERT INTO pitlane.journal_lines VALUES(journal,'processor_receivable','USD',2,-refund_delta-dispute_delta),(journal,'service_reversal','USD',2,refund_delta),(journal,'dispute_obligation','USD',2,dispute_delta);
 UPDATE pitlane.payment_settlements SET refunded_cents=refunds,disputed_cents=disputes WHERE provider_payment_id=payment;
 WITH allocations AS(SELECT provider_adjustment_id,kind,requested_cents,state,coalesce(sum(requested_cents) FILTER(WHERE state='confirmed') OVER(PARTITION BY kind ORDER BY created_at,provider_adjustment_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior FROM pitlane.payment_adjustments WHERE provider_payment_id=payment)
 UPDATE pitlane.payment_adjustments a SET applied_cents=CASE WHEN x.state='released' THEN 0 ELSE least(x.requested_cents,greatest(0,CASE WHEN x.kind='refund' THEN refunds ELSE disputes END-x.prior)) END FROM allocations x WHERE a.provider_adjustment_id=x.provider_adjustment_id;
 IF s.order_id IS NOT NULL THEN
  UPDATE pitlane.orders SET refunded_cents=refunds,state=CASE WHEN refunds=settled_cents THEN 'refunded' ELSE state END WHERE id=s.order_id;
  UPDATE pitlane.entitlement_lots SET ends_at=least(ends_at,now()) WHERE source_key='pilot/'||s.order_id::text||'/retest';
 END IF;
 IF s.subscription_id IS NOT NULL THEN PERFORM pitlane.restrict_subscription(s.subscription_id);END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.refund_result(operation_id uuid,outcome text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE op pitlane.payment_outbox;r pitlane.refund_requests;o pitlane.orders;s pitlane.payment_settlements;
BEGIN
 SELECT * INTO op FROM pitlane.payment_outbox WHERE id=operation_id AND operation='refund';IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 SELECT * INTO o FROM pitlane.orders WHERE id=op.order_id FOR UPDATE;
 SELECT * INTO r FROM pitlane.refund_requests WHERE id=split_part(op.business_key,'/',3)::uuid AND order_id=o.id FOR UPDATE;
 IF NOT FOUND OR op.amount_cents<>r.amount_cents THEN RAISE EXCEPTION 'INVALID_REFUND';END IF;
 IF r.state='settled' THEN RETURN;END IF;
 IF outcome='settled' THEN
  SELECT * INTO s FROM pitlane.payment_settlements WHERE provider_payment_id=o.provider_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'UNCONFIRMED_SETTLEMENT';END IF;
  IF r.amount_cents+s.refunded_cents>s.amount_cents THEN RAISE EXCEPTION 'REFUND_EXCEEDS_SETTLEMENT';END IF;
  INSERT INTO pitlane.payment_adjustments VALUES('local/'||op.id::text,o.provider_id,'refund',r.amount_cents,0,'confirmed',op.business_key,now());
  PERFORM pitlane.rebalance_payment_adjustments(o.provider_id,op.business_key);
  UPDATE pitlane.refund_requests SET state='settled',settled_at=now() WHERE id=r.id;
 ELSIF outcome IN('pending_reconciliation','failed') THEN UPDATE pitlane.refund_requests SET state=outcome WHERE id=r.id;
 ELSE RAISE EXCEPTION 'INVALID_REFUND_STATE';END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.apply_payment_adjustment(adjustment text,payment text,category text,amount bigint,provider_state text,k text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE s pitlane.payment_settlements;a pitlane.payment_adjustments;op pitlane.payment_outbox;alias text;
BEGIN
 IF category NOT IN('refund','dispute') OR amount<=0 OR provider_state NOT IN('confirmed','released') OR category='refund' AND provider_state='released' THEN RAISE EXCEPTION 'INVALID_PAYMENT_ADJUSTMENT';END IF;
 SELECT * INTO s FROM pitlane.payment_settlements WHERE provider_payment_id=payment;IF NOT FOUND THEN RAISE EXCEPTION 'UNCONFIRMED_SETTLEMENT';END IF;
 IF s.order_id IS NOT NULL THEN PERFORM 1 FROM pitlane.orders WHERE id=s.order_id FOR UPDATE;END IF;
 SELECT * INTO s FROM pitlane.payment_settlements WHERE provider_payment_id=payment FOR UPDATE;
 IF amount>s.amount_cents THEN RAISE EXCEPTION 'REFUND_EXCEEDS_SETTLEMENT';END IF;
 SELECT local_adjustment_id INTO alias FROM pitlane.payment_adjustment_aliases WHERE provider_adjustment_id=adjustment;
 SELECT * INTO a FROM pitlane.payment_adjustments WHERE provider_adjustment_id=coalesce(alias,adjustment);
 IF FOUND THEN
  IF a.provider_payment_id<>payment OR a.kind<>category OR a.requested_cents<>amount THEN RAISE EXCEPTION 'PAYMENT_ADJUSTMENT_IDENTITY_CONFLICT';END IF;
  IF a.state='released' OR provider_state='confirmed' THEN RETURN;END IF;
  UPDATE pitlane.payment_adjustments SET state='released' WHERE provider_adjustment_id=a.provider_adjustment_id;
  PERFORM pitlane.rebalance_payment_adjustments(payment,'provider/'||adjustment||'/released');RETURN;
 END IF;
 IF category='refund' AND k IS NOT NULL THEN
  SELECT * INTO op FROM pitlane.payment_outbox WHERE business_key=k AND order_id=s.order_id AND operation='refund';
  IF FOUND THEN
   IF op.amount_cents<>amount THEN RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH';END IF;
   PERFORM pitlane.refund_result(op.id,'settled');PERFORM pitlane.finish_billing_operation(op.id);
   IF EXISTS(SELECT FROM pitlane.payment_adjustment_aliases WHERE local_adjustment_id='local/'||op.id::text AND provider_adjustment_id<>adjustment) THEN RAISE EXCEPTION 'PAYMENT_ADJUSTMENT_IDENTITY_CONFLICT';END IF;
   INSERT INTO pitlane.payment_adjustment_aliases VALUES(adjustment,'local/'||op.id::text);RETURN;
  END IF;
 END IF;
 INSERT INTO pitlane.payment_adjustments VALUES(adjustment,payment,category,amount,0,provider_state,NULL,now());
 PERFORM pitlane.rebalance_payment_adjustments(payment,'provider/'||adjustment);
END $$;
ALTER TABLE pitlane.payment_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitlane.payment_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_settlement_read ON pitlane.payment_settlements FOR SELECT USING(pitlane.can_billing(tenant_id));
CREATE POLICY payment_adjustment_read ON pitlane.payment_adjustments FOR SELECT USING(EXISTS(SELECT FROM pitlane.payment_settlements s WHERE s.provider_payment_id=payment_adjustments.provider_payment_id AND pitlane.can_billing(s.tenant_id)));
GRANT SELECT ON pitlane.payment_settlements,pitlane.payment_adjustments,pitlane.subscription_purchases TO pitlane_web;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.subscription_plans(),pitlane.purchase_subscription(text,text,text),pitlane.subscription_purchase_status(uuid) TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.claim_payment_events(text[],integer,text,text),pitlane.complete_payment_event(text,bigint),pitlane.fail_payment_event(text,bigint,text,boolean),pitlane.configure_billing_catalog(text,text,jsonb),pitlane.claim_subscription_purchases(text,text),pitlane.billing_customer(uuid,text,text),pitlane.link_billing_customer(uuid,text,text,text),pitlane.subscription_checkout_created(uuid,bigint,text,text,text),pitlane.fail_subscription_purchase(uuid,bigint,text,boolean),pitlane.subscription_for_checkout(text),pitlane.trust_subscription_checkout(uuid,text,text),pitlane.expire_subscription_checkout(uuid),pitlane.expiring_subscription_checkouts(text,text),pitlane.subscription_settle_verified(text,text,text,text,timestamptz,timestamptz,bigint,text,text,text),pitlane.payment_settlement(text),pitlane.restrict_subscription(text),pitlane.apply_payment_adjustment(text,text,text,bigint,text,text) TO pitlane_billing;
GRANT EXECUTE ON FUNCTION pitlane.subscription_external_attempt(uuid,bigint,text) TO pitlane_billing;
