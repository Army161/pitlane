CREATE TABLE IF NOT EXISTS pitlane.fixture_payments(id text PRIMARY KEY,state text NOT NULL,amount bigint NOT NULL CHECK(amount>0),refunded bigint NOT NULL DEFAULT 0,capture_before timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS pitlane.fixture_payment_operations(key text PRIMARY KEY,payment_id text NOT NULL REFERENCES pitlane.fixture_payments(id),operation text NOT NULL,amount bigint NOT NULL);
CREATE OR REPLACE FUNCTION pitlane.fixture_payment(op text,payment text,requested bigint,k text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pitlane AS $$
DECLARE p pitlane.fixture_payments;prior pitlane.fixture_payment_operations;
BEGIN
 IF (SELECT mode FROM pitlane.runtime)<>'local' THEN RAISE EXCEPTION 'FIXTURE_PAYMENTS_PROHIBITED';END IF;
 IF op='authorize' THEN INSERT INTO pitlane.fixture_payments VALUES(payment,'authorized',requested,0,now()+interval '1 hour') ON CONFLICT DO NOTHING;END IF;
 SELECT * INTO p FROM pitlane.fixture_payments WHERE id=payment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_UNAVAILABLE';END IF;
 IF op='authorize' AND p.amount<>requested THEN RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH';END IF;
 IF op IN('capture','cancel','refund') THEN
  SELECT * INTO prior FROM pitlane.fixture_payment_operations WHERE key=k;
  IF FOUND THEN IF prior.payment_id<>payment OR prior.operation<>op OR prior.amount<>requested THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';END IF;
  ELSE
   IF op='capture' THEN
    IF requested<>p.amount THEN RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH';END IF;
    IF p.capture_before<=now() THEN UPDATE pitlane.fixture_payments SET state='authorization_expired' WHERE id=payment;
    ELSIF p.state='authorized' THEN UPDATE pitlane.fixture_payments SET state='settled' WHERE id=payment;
    ELSIF p.state<>'settled' THEN RAISE EXCEPTION 'INVALID_PAYMENT_STATE';END IF;
   ELSIF op='cancel' AND p.state<>'settled' THEN UPDATE pitlane.fixture_payments SET state='cancelled' WHERE id=payment;
   ELSIF op='refund' THEN
    IF p.state<>'settled' OR requested<=0 OR p.refunded+requested>p.amount THEN RAISE EXCEPTION 'REFUND_EXCEEDS_SETTLEMENT';END IF;
    UPDATE pitlane.fixture_payments SET refunded=refunded+requested WHERE id=payment;
   END IF;
   INSERT INTO pitlane.fixture_payment_operations VALUES(k,payment,op,requested);
  END IF;
 ELSIF op NOT IN('authorize','retrieve') THEN RAISE EXCEPTION 'INVALID_PAYMENT_OPERATION';END IF;
 SELECT * INTO p FROM pitlane.fixture_payments WHERE id=payment;
 RETURN jsonb_build_object('state',p.state,'amount',p.amount::text,'captureBefore',p.capture_before,'refunded',p.refunded::text,'origin','fixture');
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pitlane FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pitlane.fixture_payment(text,text,bigint,text) TO pitlane_billing;
