-- Forward repair: recoverable payment delinquency is distinct from durable
-- cancellation/financial restrictions. Original settled allowance is never reset.
ALTER TABLE pitlane.billing_subscriptions ADD COLUMN restriction_reason text CHECK(restriction_reason IN('delinquent','cancelled','financial_review'));
UPDATE pitlane.billing_subscriptions SET restriction_reason='financial_review' WHERE restricted;
ALTER TABLE pitlane.entitlement_lots ADD COLUMN billing_original_end timestamptz;
CREATE OR REPLACE FUNCTION pitlane.restrict_subscription(subscription text,reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 IF reason NOT IN('delinquent','cancelled','financial_review') THEN RAISE EXCEPTION 'INVALID_SUBSCRIPTION_STATE';END IF;
 UPDATE pitlane.billing_subscriptions SET restricted=true,restriction_reason=CASE WHEN restriction_reason='financial_review' THEN 'financial_review' WHEN restriction_reason='cancelled' AND reason='delinquent' THEN 'cancelled' ELSE reason END WHERE provider_subscription_id=subscription;
 UPDATE pitlane.entitlement_lots SET billing_original_end=coalesce(billing_original_end,ends_at),ends_at=least(ends_at,now()) WHERE source_key IN(SELECT 'invoice/'||invoice_id FROM pitlane.payment_settlements WHERE subscription_id=subscription);
 IF reason='cancelled' THEN UPDATE pitlane.subscription_purchases SET state='expired' WHERE provider_subscription_id=subscription AND state='linked';END IF;
END $$;

ALTER FUNCTION pitlane.subscription_settle_verified(text,text,text,text,timestamptz,timestamptz,bigint,text,text,text) RENAME TO subscription_settle_verified_initial;
REVOKE EXECUTE ON FUNCTION pitlane.subscription_settle_verified_initial(text,text,text,text,timestamptz,timestamptz,bigint,text,text,text) FROM pitlane_billing;
CREATE FUNCTION pitlane.subscription_settle_verified(invoice text,subscription text,customer text,price text,period_start timestamptz,period_end timestamptz,paid bigint,payment text,account text,environment text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN
 PERFORM pitlane.subscription_settle_verified_initial(invoice,subscription,customer,price,period_start,period_end,paid,payment,account,environment);
 IF EXISTS(SELECT FROM pitlane.billing_subscriptions WHERE provider_subscription_id=subscription AND restricted) THEN UPDATE pitlane.entitlement_lots SET billing_original_end=coalesce(billing_original_end,period_end) WHERE source_key='invoice/'||invoice;END IF;
END $$;
CREATE OR REPLACE FUNCTION pitlane.restrict_subscription(subscription text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$ BEGIN PERFORM pitlane.restrict_subscription(subscription,'financial_review');END $$;
CREATE OR REPLACE FUNCTION pitlane.recover_subscription(subscription text,customer text,account text,environment text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE s pitlane.billing_subscriptions;
BEGIN
 SELECT * INTO s FROM pitlane.billing_subscriptions WHERE provider_subscription_id=subscription AND provider_customer_id=customer AND provider_account=account AND origin=environment FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 IF s.restriction_reason<>'delinquent' OR s.restriction_reason IS NULL OR EXISTS(SELECT FROM pitlane.tenants WHERE id=s.tenant_id AND deleted_at IS NOT NULL) THEN RETURN;END IF;
 UPDATE pitlane.billing_subscriptions SET restricted=false,restriction_reason=NULL WHERE provider_subscription_id=subscription;
 UPDATE pitlane.entitlement_lots SET ends_at=billing_original_end,billing_original_end=NULL WHERE billing_original_end IS NOT NULL AND source_key IN(SELECT 'invoice/'||invoice_id FROM pitlane.payment_settlements WHERE subscription_id=subscription);
END $$;

CREATE TABLE pitlane.subscription_cancellations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES pitlane.tenants,provider_account text NOT NULL,origin text NOT NULL CHECK(origin IN('sandbox','live')),
 business_key text NOT NULL UNIQUE,kind text NOT NULL CHECK(kind IN('subscription','checkout','discover_checkout')),provider_id text NOT NULL,provider_customer_id text,purchase_id uuid,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','retry','completed','quarantined')),attempts integer NOT NULL DEFAULT 0,lease_epoch bigint NOT NULL DEFAULT 0,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT now(),discover_until timestamptz,completed_at timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pitlane.subscription_cancellations ENABLE ROW LEVEL SECURITY;
ALTER FUNCTION pitlane.trust_subscription_checkout(uuid,text,text) RENAME TO trust_subscription_checkout_initial;
REVOKE EXECUTE ON FUNCTION pitlane.trust_subscription_checkout_initial(uuid,text,text) FROM pitlane_billing;
CREATE FUNCTION pitlane.trust_subscription_checkout(target uuid,customer text,subscription text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE p pitlane.subscription_purchases;
BEGIN
 SELECT * INTO p FROM pitlane.subscription_purchases WHERE id=target FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF EXISTS(SELECT FROM pitlane.tenants WHERE id=p.tenant_id AND deleted_at IS NOT NULL) THEN
  IF p.provider_customer_id IS DISTINCT FROM customer OR p.provider_subscription_id IS NOT NULL AND p.provider_subscription_id<>subscription THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;
  INSERT INTO pitlane.billing_subscriptions(provider_subscription_id,tenant_id,provider_customer_id,plan_version,provider_account,origin,plan_id,price_id,restricted,restriction_reason)
   SELECT subscription,p.tenant_id,customer,p.plan_version,p.provider_account,p.origin,p.plan_id,c.price_id,true,'cancelled' FROM pitlane.billing_catalog c WHERE c.provider_account=p.provider_account AND c.origin=p.origin AND c.plan_id=p.plan_id AND c.version=p.plan_version ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT FROM pitlane.billing_subscriptions WHERE provider_subscription_id=subscription AND tenant_id=p.tenant_id AND provider_customer_id=customer AND provider_account=p.provider_account AND origin=p.origin AND plan_version=p.plan_version AND plan_id=p.plan_id) THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;
  UPDATE pitlane.subscription_purchases SET provider_subscription_id=subscription WHERE id=target;PERFORM pitlane.restrict_subscription(subscription,'cancelled');RETURN;
 END IF;
 PERFORM pitlane.trust_subscription_checkout_initial(target,customer,subscription);
END $$;
CREATE FUNCTION pitlane.record_deleted_subscription_checkout(target uuid,checkout text,customer text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE p pitlane.subscription_purchases;
BEGIN SELECT * INTO p FROM pitlane.subscription_purchases WHERE id=target FOR UPDATE;IF NOT FOUND OR NOT EXISTS(SELECT FROM pitlane.tenants WHERE id=p.tenant_id AND deleted_at IS NOT NULL) OR p.checkout_id IS NOT NULL AND p.checkout_id<>checkout OR p.provider_customer_id IS NOT NULL AND p.provider_customer_id<>customer OR NOT EXISTS(SELECT FROM pitlane.billing_customers WHERE tenant_id=p.tenant_id AND provider_customer_id=customer AND provider_account=p.provider_account AND origin=p.origin) THEN RAISE EXCEPTION 'FOREIGN_PAYMENT_SCOPE';END IF;UPDATE pitlane.subscription_purchases SET checkout_id=checkout,provider_customer_id=customer WHERE id=target;END $$;
-- Retention owns the original deletion behavior. Preserve its transaction and
-- privilege checks; capture provider obligations before returning to the caller.
ALTER FUNCTION pitlane.delete_tenant() RENAME TO delete_tenant_retention_internal;
REVOKE EXECUTE ON FUNCTION pitlane.delete_tenant_retention_internal() FROM pitlane_web;
CREATE FUNCTION pitlane.delete_tenant() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE t uuid=pitlane.actor_tenant();s pitlane.billing_subscriptions;p pitlane.subscription_purchases;
BEGIN
 PERFORM pitlane.delete_tenant_retention_internal();
 FOR s IN SELECT * FROM pitlane.billing_subscriptions WHERE tenant_id=t FOR UPDATE LOOP
  PERFORM pitlane.restrict_subscription(s.provider_subscription_id,'cancelled');
  IF s.provider_account IS NOT NULL AND s.origin IN('sandbox','live') THEN INSERT INTO pitlane.subscription_cancellations(tenant_id,provider_account,origin,business_key,kind,provider_id,provider_customer_id) VALUES(t,s.provider_account,s.origin,'tenant/'||t::text||'/subscription/'||s.provider_subscription_id,'subscription',s.provider_subscription_id,s.provider_customer_id) ON CONFLICT DO NOTHING;END IF;
 END LOOP;
 FOR p IN SELECT * FROM pitlane.subscription_purchases WHERE tenant_id=t AND state IN('requested','awaiting_checkout') FOR UPDATE LOOP
  IF p.checkout_id IS NOT NULL THEN INSERT INTO pitlane.subscription_cancellations(tenant_id,provider_account,origin,business_key,kind,provider_id,provider_customer_id,purchase_id) VALUES(t,p.provider_account,p.origin,'tenant/'||t::text||'/checkout/'||p.id::text,'checkout',p.checkout_id,p.provider_customer_id,p.id) ON CONFLICT DO NOTHING;
  ELSIF p.checkout_attempted THEN INSERT INTO pitlane.subscription_cancellations(tenant_id,provider_account,origin,business_key,kind,provider_id,provider_customer_id,purchase_id,available_at,discover_until) VALUES(t,p.provider_account,p.origin,'tenant/'||t::text||'/discover/'||p.id::text,'discover_checkout',p.id::text,coalesce(p.provider_customer_id,(SELECT provider_customer_id FROM pitlane.billing_customers WHERE tenant_id=t AND provider_account=p.provider_account AND origin=p.origin)),p.id,greatest(now(),coalesce(p.lease_until,now())+interval '30 seconds'),greatest(p.hold_until,now()+interval '31 minutes')) ON CONFLICT DO NOTHING;END IF;
 END LOOP;
 UPDATE pitlane.subscription_purchases SET state='failed',lease_epoch=lease_epoch+1,lease_until=NULL,last_error='TENANT_DELETED' WHERE tenant_id=t AND state IN('requested','awaiting_checkout');
END $$;
CREATE FUNCTION pitlane.claim_subscription_cancellations(account text,environment text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE result jsonb;
BEGIN
 UPDATE pitlane.subscription_cancellations SET state='quarantined',lease_until=NULL,last_error='CANCELLATION_RETRIES_EXHAUSTED' WHERE attempts>=30 AND state NOT IN('completed','quarantined') AND (lease_until IS NULL OR lease_until<=now());
 WITH candidates AS(SELECT id FROM pitlane.subscription_cancellations WHERE provider_account=account AND origin=environment AND state IN('pending','processing','retry') AND attempts<30 AND available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1),updated AS(UPDATE pitlane.subscription_cancellations SET state='processing',lease_epoch=lease_epoch+1,lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id IN(SELECT id FROM candidates) RETURNING *) SELECT coalesce(jsonb_agg(updated),'[]'::jsonb) INTO result FROM updated;RETURN result;
END $$;
CREATE FUNCTION pitlane.finish_subscription_cancellation(target uuid,epoch bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.subscription_cancellations SET state='completed',completed_at=now(),lease_until=NULL,last_error=NULL WHERE id=target AND state='processing' AND lease_epoch=epoch AND lease_until>clock_timestamp();IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;END $$;
CREATE FUNCTION pitlane.retry_subscription_cancellation(target uuid,epoch bigint,code text,permanent boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
BEGIN UPDATE pitlane.subscription_cancellations SET state=CASE WHEN permanent OR attempts>=30 THEN 'quarantined' ELSE 'retry' END,available_at=now()+least(interval '1 hour',interval '1 minute'*power(2,least(attempts-1,6))),lease_until=NULL,last_error=CASE WHEN code~'^[A-Z_]{1,80}$' THEN code ELSE 'PROVIDER_RETRY_REQUIRED' END WHERE id=target AND state='processing' AND lease_epoch=epoch AND lease_until>clock_timestamp();IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_EVENT_LEASE_LOST';END IF;END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.delete_tenant() TO pitlane_web;
GRANT EXECUTE ON FUNCTION pitlane.restrict_subscription(text,text),pitlane.recover_subscription(text,text,text,text),pitlane.claim_subscription_cancellations(text,text),pitlane.finish_subscription_cancellation(uuid,bigint),pitlane.retry_subscription_cancellation(uuid,bigint,text,boolean) TO pitlane_billing;
GRANT EXECUTE ON FUNCTION pitlane.subscription_settle_verified(text,text,text,text,timestamptz,timestamptz,bigint,text,text,text) TO pitlane_billing;
GRANT EXECUTE ON FUNCTION pitlane.trust_subscription_checkout(uuid,text,text),pitlane.record_deleted_subscription_checkout(uuid,text,text) TO pitlane_billing;
