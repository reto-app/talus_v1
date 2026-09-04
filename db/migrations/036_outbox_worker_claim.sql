DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='talus_worker') THEN CREATE ROLE talus_worker NOLOGIN NOINHERIT; END IF; END $$;
SET ROLE talus_fn;
DROP POLICY IF EXISTS outbox_internal_worker ON app.communication_outbox;
CREATE POLICY outbox_internal_worker ON app.communication_outbox TO talus_fn USING (true) WITH CHECK (true);
CREATE OR REPLACE FUNCTION app.claim_outbox_batch(p_batch_size integer DEFAULT 10) RETURNS TABLE(communication_outbox_id uuid,tenant_id uuid,recipient_customer_id uuid,channel text,destination text,rendered_subject text,rendered_body text,retry_count integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=app,public AS $$ BEGIN IF p_batch_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_BATCH_SIZE';END IF;RETURN QUERY WITH c AS(SELECT o.communication_outbox_id FROM app.communication_outbox o WHERE o.status='queued' AND o.send_after<=clock_timestamp() ORDER BY o.communication_outbox_id LIMIT p_batch_size FOR UPDATE SKIP LOCKED) UPDATE app.communication_outbox o SET status='processing' FROM c WHERE o.communication_outbox_id=c.communication_outbox_id RETURNING o.communication_outbox_id,o.tenant_id,o.recipient_customer_id,o.channel,o.destination,o.rendered_subject,o.rendered_body,o.retry_count;END;$$;
GRANT EXECUTE ON FUNCTION app.claim_outbox_batch(integer) TO talus_worker,talus_api;
RESET ROLE;
