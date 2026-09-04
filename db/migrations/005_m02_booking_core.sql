-- M02: Booking Core. Configuration, pricing, payments, inspections, and
-- assignment orchestration remain owned by later modules.

CREATE EXTENSION IF NOT EXISTS btree_gist;
SET ROLE talus_fn;

CREATE TABLE app.rental_category (
  tenant_id uuid NOT NULL,
  rental_category_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, rental_category_id),
  FOREIGN KEY (tenant_id) REFERENCES app.tenant (tenant_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX rental_category_tenant_display_name_uq ON app.rental_category (tenant_id, lower(display_name));

CREATE TABLE app.category_location (
  tenant_id uuid NOT NULL,
  category_location_id uuid NOT NULL,
  rental_category_id uuid NOT NULL,
  location_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, category_location_id),
  UNIQUE (tenant_id, rental_category_id, location_id),
  FOREIGN KEY (tenant_id, rental_category_id) REFERENCES app.rental_category (tenant_id, rental_category_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, location_id) REFERENCES app.location (tenant_id, location_id) ON DELETE RESTRICT
);

CREATE TABLE app.machine (
  tenant_id uuid NOT NULL,
  machine_id uuid NOT NULL,
  category_location_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  operational_state text NOT NULL CHECK (operational_state IN ('in_service', 'out_of_service', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, machine_id),
  FOREIGN KEY (tenant_id, category_location_id) REFERENCES app.category_location (tenant_id, category_location_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX machine_tenant_display_name_uq ON app.machine (tenant_id, lower(display_name));

CREATE TABLE app.booking (
  tenant_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  booking_reference text NOT NULL CHECK (length(booking_reference) BETWEEN 1 AND 80),
  pickup_location_id uuid NOT NULL,
  return_location_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('draft', 'pending_payment', 'confirmed', 'active', 'closed', 'cancelled', 'no_show')),
  lifecycle_version bigint NOT NULL DEFAULT 1 CHECK (lifecycle_version > 0),
  item_set_revision bigint NOT NULL DEFAULT 0 CHECK (item_set_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, booking_id),
  UNIQUE (tenant_id, booking_reference),
  UNIQUE (tenant_id, booking_id, state),
  FOREIGN KEY (tenant_id, pickup_location_id) REFERENCES app.location (tenant_id, location_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, return_location_id) REFERENCES app.location (tenant_id, location_id) ON DELETE RESTRICT,
  CHECK (pickup_location_id = return_location_id)
);

CREATE TABLE app.booking_terms_revision (
  tenant_id uuid NOT NULL,
  booking_terms_revision_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (tenant_id, booking_terms_revision_id),
  UNIQUE (tenant_id, booking_id, revision_number),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES app.booking (tenant_id, booking_id) ON DELETE RESTRICT
);

CREATE TABLE app.booking_item (
  tenant_id uuid NOT NULL,
  booking_item_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  item_number integer NOT NULL CHECK (item_number > 0),
  state text NOT NULL CHECK (state IN ('reserved', 'assigned', 'ready', 'checked_out', 'returned', 'closed', 'cancelled', 'no_show')),
  lifecycle_version bigint NOT NULL DEFAULT 1 CHECK (lifecycle_version > 0),
  current_terms_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, booking_item_id),
  UNIQUE (tenant_id, booking_id, item_number),
  UNIQUE (tenant_id, booking_id, booking_item_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES app.booking (tenant_id, booking_id) ON DELETE RESTRICT
);

CREATE TABLE app.booking_item_terms_revision (
  tenant_id uuid NOT NULL,
  booking_item_terms_revision_id uuid NOT NULL,
  booking_item_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  booking_terms_revision_id uuid NOT NULL,
  category_location_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  scheduled_start_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  chargeable_day_count integer NOT NULL CHECK (chargeable_day_count > 0),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (tenant_id, booking_item_terms_revision_id),
  UNIQUE (tenant_id, booking_item_id, revision_number),
  UNIQUE (tenant_id, booking_id, booking_item_id, booking_item_terms_revision_id),
  FOREIGN KEY (tenant_id, booking_id, booking_item_id) REFERENCES app.booking_item (tenant_id, booking_id, booking_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, booking_terms_revision_id) REFERENCES app.booking_terms_revision (tenant_id, booking_terms_revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, category_location_id) REFERENCES app.category_location (tenant_id, category_location_id) ON DELETE RESTRICT,
  CHECK (scheduled_end_at > scheduled_start_at)
);

ALTER TABLE app.booking_item
  ADD CONSTRAINT booking_item_current_terms_fk
  FOREIGN KEY (tenant_id, booking_id, booking_item_id, current_terms_revision_id)
  REFERENCES app.booking_item_terms_revision (tenant_id, booking_id, booking_item_id, booking_item_terms_revision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.category_commitment (
  tenant_id uuid NOT NULL,
  booking_item_id uuid NOT NULL,
  booking_item_terms_revision_id uuid NOT NULL,
  commitment_kind text NOT NULL CHECK (commitment_kind IN ('hold', 'committed')),
  hold_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, booking_item_id),
  FOREIGN KEY (tenant_id, booking_item_id) REFERENCES app.booking_item (tenant_id, booking_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, booking_item_terms_revision_id) REFERENCES app.booking_item_terms_revision (tenant_id, booking_item_terms_revision_id) ON DELETE RESTRICT,
  CHECK ((commitment_kind = 'hold') = (hold_expires_at IS NOT NULL))
);

CREATE TABLE app.machine_occupancy (
  tenant_id uuid NOT NULL,
  machine_occupancy_id uuid NOT NULL DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL,
  booking_item_id uuid,
  booking_item_terms_revision_id uuid,
  occupancy_kind text NOT NULL CHECK (occupancy_kind IN ('rental', 'maintenance')),
  maintenance_reference_id uuid,
  blocking boolean NOT NULL DEFAULT true,
  occupancy_range tstzrange NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, machine_occupancy_id),
  FOREIGN KEY (tenant_id, machine_id) REFERENCES app.machine (tenant_id, machine_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, booking_item_id) REFERENCES app.booking_item (tenant_id, booking_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, booking_item_terms_revision_id) REFERENCES app.booking_item_terms_revision (tenant_id, booking_item_terms_revision_id) ON DELETE RESTRICT,
  CHECK (NOT isempty(occupancy_range) AND NOT lower_inf(occupancy_range) AND lower_inc(occupancy_range) AND NOT upper_inc(occupancy_range)),
  CHECK ((occupancy_kind = 'rental' AND booking_item_id IS NOT NULL AND booking_item_terms_revision_id IS NOT NULL AND maintenance_reference_id IS NULL)
      OR (occupancy_kind = 'maintenance' AND booking_item_id IS NULL AND booking_item_terms_revision_id IS NULL AND maintenance_reference_id IS NOT NULL))
);

ALTER TABLE app.machine_occupancy ADD CONSTRAINT machine_occupancy_blocking_exclusion
  EXCLUDE USING gist (tenant_id WITH =, machine_id WITH =, occupancy_range WITH &&) WHERE (blocking);
CREATE UNIQUE INDEX machine_occupancy_one_blocking_rental_per_item_uq
  ON app.machine_occupancy (tenant_id, booking_item_id) WHERE blocking AND occupancy_kind = 'rental';

CREATE TABLE app.checkout_occurrence (
  tenant_id uuid NOT NULL,
  checkout_occurrence_id uuid NOT NULL,
  booking_item_id uuid NOT NULL,
  machine_occupancy_id uuid NOT NULL,
  checkout_ordinal integer NOT NULL CHECK (checkout_ordinal > 0),
  initiated_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, checkout_occurrence_id),
  UNIQUE (tenant_id, booking_item_id, checkout_ordinal),
  FOREIGN KEY (tenant_id, booking_item_id) REFERENCES app.booking_item (tenant_id, booking_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, machine_occupancy_id) REFERENCES app.machine_occupancy (tenant_id, machine_occupancy_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, initiated_by_principal_id) REFERENCES app.principal (tenant_id, principal_id) ON DELETE RESTRICT
);

CREATE TABLE app.trip (
  tenant_id uuid NOT NULL,
  trip_id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_item_id uuid NOT NULL,
  machine_id uuid NOT NULL,
  checkout_occurrence_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, trip_id),
  UNIQUE (tenant_id, checkout_occurrence_id),
  FOREIGN KEY (tenant_id, booking_item_id) REFERENCES app.booking_item (tenant_id, booking_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, machine_id) REFERENCES app.machine (tenant_id, machine_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, checkout_occurrence_id) REFERENCES app.checkout_occurrence (tenant_id, checkout_occurrence_id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX trip_one_open_per_item_uq ON app.trip (tenant_id, booking_item_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX trip_one_open_per_machine_uq ON app.trip (tenant_id, machine_id) WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION app.m02_lock_item_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = app, pg_catalog AS $$
DECLARE v_booking_id uuid := COALESCE(NEW.booking_id, OLD.booking_id); v_state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.booking_id <> OLD.booking_id THEN RAISE EXCEPTION 'BOOKING_ITEM_REPARENT_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  SELECT b.state INTO v_state FROM app.booking AS b WHERE b.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND b.booking_id = v_booking_id FOR UPDATE;
  IF v_state IN ('closed', 'cancelled', 'no_show') THEN RAISE EXCEPTION 'TERMINAL_BOOKING_MUTATION_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BOOKING_ITEM_DELETE_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  UPDATE app.booking AS b SET item_set_revision = b.item_set_revision + 1 WHERE b.tenant_id = NEW.tenant_id AND b.booking_id = NEW.booking_id;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION app.m02_validate_closed_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = app, pg_catalog AS $$
DECLARE v_tenant_id uuid := COALESCE(NEW.tenant_id, OLD.tenant_id); v_booking_id uuid := COALESCE(NEW.booking_id, OLD.booking_id); v_state text;
BEGIN
  SELECT b.state INTO v_state FROM app.booking AS b WHERE b.tenant_id = v_tenant_id AND b.booking_id = v_booking_id;
  IF v_state = 'closed' AND (
    NOT EXISTS (SELECT 1 FROM app.booking_item AS bi WHERE bi.tenant_id = v_tenant_id AND bi.booking_id = v_booking_id)
    OR EXISTS (SELECT 1 FROM app.booking_item AS bi WHERE bi.tenant_id = v_tenant_id AND bi.booking_id = v_booking_id AND bi.state NOT IN ('closed', 'cancelled', 'no_show'))
  ) THEN RAISE EXCEPTION 'BOOKING_CLOSE_BLOCKED' USING ERRCODE = 'P0001'; END IF;
  RETURN NULL;
END; $$;

CREATE TRIGGER m02_lock_booking_item_parent BEFORE INSERT OR UPDATE OR DELETE ON app.booking_item
  FOR EACH ROW EXECUTE FUNCTION app.m02_lock_item_parent();
CREATE CONSTRAINT TRIGGER m02_validate_booking_after_item_change AFTER INSERT OR UPDATE OR DELETE ON app.booking_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.m02_validate_closed_booking();
CREATE CONSTRAINT TRIGGER m02_validate_booking_after_booking_change AFTER UPDATE OF state ON app.booking
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.m02_validate_closed_booking();

CREATE OR REPLACE FUNCTION app.m02_terms_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = app, pg_catalog AS $$
BEGIN RAISE EXCEPTION 'TERMS_REVISION_IMMUTABLE' USING ERRCODE = 'P0001'; END; $$;
CREATE TRIGGER m02_booking_terms_immutable BEFORE UPDATE OR DELETE ON app.booking_terms_revision FOR EACH ROW EXECUTE FUNCTION app.m02_terms_immutable();
CREATE TRIGGER m02_booking_item_terms_immutable BEFORE UPDATE OR DELETE ON app.booking_item_terms_revision FOR EACH ROW EXECUTE FUNCTION app.m02_terms_immutable();

CREATE OR REPLACE FUNCTION app.read_core_availability(p_tenant_id uuid, p_category_location_id uuid, p_start_at timestamptz, p_end_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_supply integer; v_demand integer;
BEGIN
  IF p_end_at <= p_start_at THEN RAISE EXCEPTION 'INVALID_DATE_RANGE' USING ERRCODE = '22023'; END IF;
  SELECT count(*)::integer INTO v_supply FROM app.machine AS m
   WHERE m.tenant_id = p_tenant_id AND m.category_location_id = p_category_location_id AND m.operational_state = 'in_service'
     AND NOT EXISTS (SELECT 1 FROM app.machine_occupancy AS mo WHERE mo.tenant_id = m.tenant_id AND mo.machine_id = m.machine_id AND mo.blocking AND mo.occupancy_kind = 'maintenance' AND mo.occupancy_range && tstzrange(p_start_at, p_end_at, '[)'));
  SELECT count(*)::integer INTO v_demand FROM app.category_commitment AS cc
   JOIN app.booking_item_terms_revision AS it ON it.tenant_id = cc.tenant_id AND it.booking_item_terms_revision_id = cc.booking_item_terms_revision_id
   WHERE cc.tenant_id = p_tenant_id AND it.category_location_id = p_category_location_id AND tstzrange(it.scheduled_start_at, it.scheduled_end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
     AND (cc.commitment_kind = 'committed' OR cc.hold_expires_at > clock_timestamp());
  RETURN GREATEST(v_supply - v_demand, 0);
END; $$;

CREATE OR REPLACE FUNCTION app.accept_core_commitment(p_booking_item_id uuid, p_commitment_kind text, p_hold_expires_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_item app.booking_item%ROWTYPE; v_terms app.booking_item_terms_revision%ROWTYPE; v_available integer;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT bi.* INTO v_item FROM app.booking_item AS bi WHERE bi.tenant_id = app.current_context_tenant_id() AND bi.booking_item_id = p_booking_item_id FOR UPDATE;
  IF NOT FOUND OR v_item.state <> 'reserved' OR v_item.current_terms_revision_id IS NULL THEN RAISE EXCEPTION 'COMMITMENT_NOT_ACCEPTABLE' USING ERRCODE = 'P0001'; END IF;
  SELECT it.* INTO v_terms FROM app.booking_item_terms_revision AS it WHERE it.tenant_id = v_item.tenant_id AND it.booking_item_terms_revision_id = v_item.current_terms_revision_id;
  PERFORM 1 FROM app.category_location AS cl WHERE cl.tenant_id = v_item.tenant_id AND cl.category_location_id = v_terms.category_location_id FOR UPDATE;
  v_available := app.read_core_availability(v_item.tenant_id, v_terms.category_location_id, v_terms.scheduled_start_at, v_terms.scheduled_end_at);
  IF v_available < 1 THEN RAISE EXCEPTION 'CAPACITY_EXCEEDED' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO app.category_commitment AS cc (tenant_id, booking_item_id, booking_item_terms_revision_id, commitment_kind, hold_expires_at)
  VALUES (v_item.tenant_id, v_item.booking_item_id, v_terms.booking_item_terms_revision_id, p_commitment_kind, p_hold_expires_at);
  PERFORM app.append_audit('booking_item.commitment_accepted', 'booking_item', v_item.booking_item_id, NULL, jsonb_build_object('kind', p_commitment_kind));
END; $$;

CREATE OR REPLACE FUNCTION app.core_close_booking(p_booking_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE v_booking app.booking%ROWTYPE;
BEGIN
  PERFORM app.require_staff_role('staff');
  SELECT b.* INTO v_booking FROM app.booking AS b WHERE b.tenant_id = app.current_context_tenant_id() AND b.booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM app.booking_item AS bi WHERE bi.tenant_id = v_booking.tenant_id AND bi.booking_id = v_booking.booking_id AND bi.state NOT IN ('closed', 'cancelled', 'no_show'))
     OR NOT EXISTS (SELECT 1 FROM app.booking_item AS bi WHERE bi.tenant_id = v_booking.tenant_id AND bi.booking_id = v_booking.booking_id)
  THEN RAISE EXCEPTION 'BOOKING_CLOSE_BLOCKED' USING ERRCODE = 'P0001'; END IF;
  UPDATE app.booking AS b SET state = 'closed', lifecycle_version = b.lifecycle_version + 1 WHERE b.tenant_id = v_booking.tenant_id AND b.booking_id = v_booking.booking_id;
  PERFORM app.append_audit('booking.closed', 'booking', v_booking.booking_id);
END; $$;

ALTER TABLE app.rental_category ENABLE ROW LEVEL SECURITY; ALTER TABLE app.rental_category FORCE ROW LEVEL SECURITY;
ALTER TABLE app.category_location ENABLE ROW LEVEL SECURITY; ALTER TABLE app.category_location FORCE ROW LEVEL SECURITY;
ALTER TABLE app.machine ENABLE ROW LEVEL SECURITY; ALTER TABLE app.machine FORCE ROW LEVEL SECURITY;
ALTER TABLE app.booking ENABLE ROW LEVEL SECURITY; ALTER TABLE app.booking FORCE ROW LEVEL SECURITY;
ALTER TABLE app.booking_terms_revision ENABLE ROW LEVEL SECURITY; ALTER TABLE app.booking_terms_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE app.booking_item ENABLE ROW LEVEL SECURITY; ALTER TABLE app.booking_item FORCE ROW LEVEL SECURITY;
ALTER TABLE app.booking_item_terms_revision ENABLE ROW LEVEL SECURITY; ALTER TABLE app.booking_item_terms_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE app.category_commitment ENABLE ROW LEVEL SECURITY; ALTER TABLE app.category_commitment FORCE ROW LEVEL SECURITY;
ALTER TABLE app.machine_occupancy ENABLE ROW LEVEL SECURITY; ALTER TABLE app.machine_occupancy FORCE ROW LEVEL SECURITY;
ALTER TABLE app.checkout_occurrence ENABLE ROW LEVEL SECURITY; ALTER TABLE app.checkout_occurrence FORCE ROW LEVEL SECURITY;
ALTER TABLE app.trip ENABLE ROW LEVEL SECURITY; ALTER TABLE app.trip FORCE ROW LEVEL SECURITY;

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['rental_category','category_location','machine','booking','booking_terms_revision','booking_item','booking_item_terms_revision','category_commitment','machine_occupancy','checkout_occurrence','trip'] LOOP
  EXECUTE format('CREATE POLICY tenant_context_policy ON app.%I USING (tenant_id = app.current_context_tenant_id() AND app.context_is_valid()) WITH CHECK (tenant_id = app.current_context_tenant_id() AND app.context_is_valid())', t);
END LOOP; END; $$;

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM talus_api, talus_customer, talus_staff, talus_device;
REVOKE ALL ON FUNCTION app.accept_core_commitment(uuid, text, timestamptz), app.core_close_booking(uuid) FROM PUBLIC, talus_api, talus_customer, talus_staff, talus_device;
RESET ROLE;
