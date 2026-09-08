import { DomainError } from "./operations-service.js";

const tenant = "app.current_context_tenant_id()";

export async function getDispatchGateWorkflow(client, { bookingItemId, outboundInspectionId = null }) {
  // Lock the item first so a staff decision and the subsequent state transition
  // share one transaction boundary.
  const item = (await client.query(
    `SELECT booking_item_id FROM app.booking_item
      WHERE tenant_id=${tenant} AND booking_item_id=$1 FOR UPDATE`,
    [bookingItemId],
  )).rows[0];
  if (!item) throw new DomainError("BOOKING_ITEM_NOT_FOUND", 404);

  const gate = (await client.query(
    `WITH policy AS (
       SELECT tenant_waiver_policy_id
         FROM app.tenant_waiver_policy
        WHERE tenant_id=${tenant}
        ORDER BY version_number DESC LIMIT 1
     ),
     inspection_policy AS (SELECT * FROM app.inspection_policy_effective()),
     deposit_policy AS (SELECT app.deposit_required_effective() AS required)
     SELECT
       EXISTS (SELECT 1 FROM app.machine_occupancy o
                WHERE o.tenant_id=${tenant} AND o.booking_item_id=$1
                  AND o.occupancy_kind='rental' AND o.blocking) AS assignment_ready,
       (SELECT required FROM deposit_policy) AS deposit_required,
       EXISTS (SELECT 1 FROM app.booking_item_deposit_hold h
                WHERE h.tenant_id=${tenant} AND h.booking_item_id=$1)
         OR NOT (SELECT required FROM deposit_policy) AS deposit_ready,
       (SELECT pre_checkout_required FROM inspection_policy) AS outbound_inspection_required,
       EXISTS (SELECT 1 FROM app.inspection i
                WHERE i.tenant_id=${tenant} AND i.booking_item_id=$1
                  AND i.inspection_type='outbound' AND i.status='completed'
                  AND ($2::uuid IS NULL OR i.inspection_id=$2)
                  AND NOT EXISTS (SELECT 1 FROM app.inspection_item ii WHERE ii.tenant_id=${tenant} AND ii.inspection_id=i.inspection_id AND ii.condition='fail')
              ) OR NOT (SELECT pre_checkout_required FROM inspection_policy) AS outbound_inspection_ready,
       EXISTS (SELECT 1 FROM app.inspection i
                WHERE i.tenant_id=${tenant} AND i.booking_item_id=$1
                  AND i.inspection_type='outbound' AND i.status='completed'
                  AND ($2::uuid IS NULL OR i.inspection_id=$2)
                  AND EXISTS (SELECT 1 FROM app.inspection_item ii WHERE ii.tenant_id=${tenant} AND ii.inspection_id=i.inspection_id AND ii.condition='fail')
              ) AS outbound_inspection_unsafe,
       EXISTS (SELECT 1 FROM app.booking_driver d WHERE d.tenant_id=${tenant} AND d.booking_item_id=$1)
       AND NOT EXISTS (
         SELECT 1 FROM app.booking_driver d
          WHERE d.tenant_id=${tenant} AND d.booking_item_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM app.executed_waiver w CROSS JOIN policy p
               WHERE w.tenant_id=${tenant} AND w.customer_id=d.customer_id
                 AND w.booking_item_id=d.booking_item_id
                 AND w.waiver_policy_version_id=p.tenant_waiver_policy_id
            )
       ) AS waiver_ready`,
    [bookingItemId, outboundInspectionId],
  )).rows[0];

  const missingRequirements = [
    !gate.assignment_ready && "machine_assignment",
    !gate.waiver_ready && "signed_waiver",
    !gate.deposit_ready && "deposit_hold",
    !gate.outbound_inspection_ready && "outbound_inspection",
    // An unsafe finding blocks dispatch even when policy does not require
    // the inspection at all -- a known safety issue is never ignorable.
    gate.outbound_inspection_unsafe && "unsafe_inspection",
  ].filter(Boolean);
  return { isReady: missingRequirements.length === 0, missingRequirements, ...gate };
}

export async function assertDispatchGateWorkflow(client, input) {
  const gate = await getDispatchGateWorkflow(client, input);
  if (!gate.isReady) throw new DomainError("DISPATCH_GATE_INCOMPLETE", 422, gate);
  return gate;
}

export async function getDispatchBoardWorkflow(client, { date, categoryLocationId, bookingItemId } = {}) {
  // Day boundaries are computed in the OPERATING LOCATION's own timezone
  // (app.location.timezone_name), not the database session's timezone --
  // otherwise a US-timezone yard reviewing "today" can silently see
  // yesterday's or tomorrow's pickups depending on where Postgres runs.
  // Each booking item can be at a different location, so boundaries are
  // computed per-row via a LATERAL join rather than once for the request.
  const rows = await client.query(
    `SELECT bi.booking_item_id, b.booking_id, b.booking_reference, b.state AS booking_state,
            bi.state AS booking_item_state, terms.category_location_id, terms.scheduled_start_at, terms.scheduled_end_at,
            loc.timezone_name, customer.display_name AS customer_name,
            COALESCE(cp.email, customer.email) AS customer_email, cp.phone AS customer_phone,
            product.display_name AS product_name,
            assignment.machine_id, assignment.fleet_number,
            app.deposit_required_effective() AS deposit_required,
            EXISTS (SELECT 1 FROM app.booking_item_deposit_hold h
                     WHERE h.tenant_id=b.tenant_id AND h.booking_item_id=bi.booking_item_id)
              OR NOT app.deposit_required_effective() AS deposit_ready,
            (SELECT pre_checkout_required FROM app.inspection_policy_effective()) AS outbound_inspection_required,
            EXISTS (SELECT 1 FROM app.inspection i WHERE i.tenant_id=b.tenant_id
                     AND i.booking_item_id=bi.booking_item_id AND i.inspection_type='outbound'
                     AND i.status='completed'
                     AND NOT EXISTS (SELECT 1 FROM app.inspection_item ii WHERE ii.tenant_id=b.tenant_id AND ii.inspection_id=i.inspection_id AND ii.condition='fail')
                    ) OR NOT (SELECT pre_checkout_required FROM app.inspection_policy_effective()) AS outbound_inspection_ready,
            (SELECT post_return_required FROM app.inspection_policy_effective()) AS inbound_inspection_required,
            EXISTS (SELECT 1 FROM app.inspection i WHERE i.tenant_id=b.tenant_id
                     AND i.booking_item_id=bi.booking_item_id AND i.inspection_type='inbound' AND i.status='completed'
                    ) AS inbound_inspection_ready,
            EXISTS (SELECT 1 FROM app.booking_driver d WHERE d.tenant_id=b.tenant_id AND d.booking_item_id=bi.booking_item_id)
            AND NOT EXISTS (
              SELECT 1 FROM app.booking_driver d
               WHERE d.tenant_id=b.tenant_id AND d.booking_item_id=bi.booking_item_id
                 AND NOT EXISTS (
                   SELECT 1 FROM app.executed_waiver w
                    WHERE w.tenant_id=d.tenant_id AND w.customer_id=d.customer_id
                      AND w.booking_item_id=d.booking_item_id
                      AND w.waiver_policy_version_id=(SELECT tenant_waiver_policy_id FROM app.tenant_waiver_policy p WHERE p.tenant_id=b.tenant_id ORDER BY p.version_number DESC LIMIT 1)
                 )
            ) AS waiver_ready,
            NOT EXISTS (SELECT 1 FROM app.booking_item_deposit_hold h WHERE h.tenant_id=b.tenant_id AND h.booking_item_id=bi.booking_item_id)
              OR EXISTS (
                SELECT 1 FROM app.deposit_hold_settlement s
                  JOIN app.trip tr ON tr.tenant_id=s.tenant_id AND tr.trip_id=s.trip_id
                 WHERE tr.tenant_id=b.tenant_id AND tr.booking_item_id=bi.booking_item_id
              ) AS settlement_ready,
            active_trip.trip_id IS NOT NULL AS active_trip,
            CASE
              WHEN bi.state = 'cancelled' THEN 'cancelled'
              WHEN bi.state = 'no_show' THEN 'no_show'
              WHEN bi.state = 'closed' THEN 'closed'
              WHEN bi.state = 'returned' THEN 'returned'
              WHEN active_trip.trip_id IS NOT NULL AND terms.scheduled_end_at < day.day_start THEN 'overdue'
              WHEN active_trip.trip_id IS NOT NULL AND terms.scheduled_end_at >= day.day_start AND terms.scheduled_end_at < day.day_end THEN 'return_due'
              WHEN active_trip.trip_id IS NOT NULL THEN 'on_rent'
              ELSE 'pickup'
            END AS dispatch_bucket
       FROM app.booking_item bi
       JOIN app.booking b ON b.tenant_id=bi.tenant_id AND b.booking_id=bi.booking_id
       JOIN app.booking_item_terms_revision terms ON terms.tenant_id=bi.tenant_id
            AND terms.booking_item_terms_revision_id=bi.current_terms_revision_id
       JOIN app.category_location cl ON cl.tenant_id=terms.tenant_id AND cl.category_location_id=terms.category_location_id
       JOIN app.location loc ON loc.tenant_id=cl.tenant_id AND loc.location_id=cl.location_id
       LEFT JOIN app.booking_customer bc ON bc.tenant_id=b.tenant_id AND bc.booking_id=b.booking_id
       LEFT JOIN app.customer customer ON customer.tenant_id=bc.tenant_id AND customer.customer_id=bc.customer_id
       LEFT JOIN app.customer_profile cp ON cp.tenant_id=customer.tenant_id AND cp.customer_id=customer.customer_id
       LEFT JOIN LATERAL (
         SELECT p.display_name FROM app.rental_product p
          WHERE p.tenant_id=terms.tenant_id AND p.category_location_id=terms.category_location_id AND p.active
          ORDER BY p.rental_product_id LIMIT 1
       ) product ON true
       LEFT JOIN LATERAL (
         -- Once a trip exists, its machine is the authoritative, stable
         -- answer to "which machine is/was this item's" -- including after
         -- return, when app.receive_booking_return frees the occupancy's
         -- blocking flag so the machine can be reassigned elsewhere.
         -- Before dispatch, fall back to the currently-blocking occupancy
         -- (assigned but not yet checked out).
         SELECT m.machine_id, m.fleet_number FROM app.machine m
          WHERE m.tenant_id=bi.tenant_id AND m.machine_id = COALESCE(
            (SELECT t.machine_id FROM app.trip t
              WHERE t.tenant_id=bi.tenant_id AND t.booking_item_id=bi.booking_item_id
              ORDER BY t.started_at DESC LIMIT 1),
            (SELECT o.machine_id FROM app.machine_occupancy o
              WHERE o.tenant_id=bi.tenant_id AND o.booking_item_id=bi.booking_item_id
                AND o.occupancy_kind='rental' AND o.blocking LIMIT 1)
          )
       ) assignment ON true
       LEFT JOIN LATERAL (
         SELECT t.trip_id FROM app.trip t
          WHERE t.tenant_id=b.tenant_id AND t.booking_item_id=bi.booking_item_id AND t.ended_at IS NULL
          LIMIT 1
       ) active_trip ON true
       CROSS JOIN LATERAL (
         SELECT (COALESCE($1::date, (clock_timestamp() AT TIME ZONE loc.timezone_name)::date))::timestamp AT TIME ZONE loc.timezone_name AS day_start,
                ((COALESCE($1::date, (clock_timestamp() AT TIME ZONE loc.timezone_name)::date)) + 1)::timestamp AT TIME ZONE loc.timezone_name AS day_end
       ) day
      WHERE b.tenant_id=${tenant}
        AND ($2::uuid IS NULL OR terms.category_location_id=$2)
        AND ($3::uuid IS NULL OR bi.booking_item_id=$3)
        AND (
          $3::uuid IS NOT NULL
          -- pickups and returns scheduled for the selected day
          OR (terms.scheduled_start_at >= day.day_start AND terms.scheduled_start_at < day.day_end)
          OR (terms.scheduled_end_at >= day.day_start AND terms.scheduled_end_at < day.day_end)
          -- anything currently on rent or overdue stays visible regardless of pickup date
          OR active_trip.trip_id IS NOT NULL
        )
      ORDER BY CASE
                 WHEN bi.state IN ('closed','cancelled','no_show') THEN 5
                 WHEN bi.state = 'returned' THEN 4
                 WHEN active_trip.trip_id IS NOT NULL AND terms.scheduled_end_at < day.day_start THEN 0
                 WHEN active_trip.trip_id IS NOT NULL THEN 2
                 ELSE 1
               END,
               terms.scheduled_start_at, bi.booking_item_id`,
    [date ?? null, categoryLocationId ?? null, bookingItemId ?? null],
  );
  return { items: rows.rows, generatedAt: new Date().toISOString() };
}

export async function getBookingItemWorkflow(client, { bookingItemId }) {
  const board = await getDispatchBoardWorkflow(client, { bookingItemId });
  const item = board.items.find((row) => row.booking_item_id === bookingItemId);
  if (!item) throw new DomainError("BOOKING_ITEM_NOT_FOUND", 404);
  const gate = await getDispatchGateWorkflow(client, { bookingItemId });
  const inspections = await client.query(
    `SELECT inspection_id, inspection_type, status, completed_at, fuel_pct, odometer_miles
       FROM app.inspection WHERE tenant_id=${tenant} AND booking_item_id=$1
      ORDER BY completed_at NULLS LAST, inspection_id`, [bookingItemId],
  );
  return { ...item, gate, inspections: inspections.rows };
}

export async function getAvailableMachinesWorkflow(client, { categoryLocationId, start, end }) {
  if (!categoryLocationId || !start || !end) throw new DomainError("MACHINE_AVAILABILITY_INPUT_INVALID", 422);
  const result = await client.query(
    `SELECT m.machine_id, m.fleet_number, m.display_name, m.operational_state
       FROM app.machine m
      WHERE m.tenant_id=${tenant} AND m.category_location_id=$1
        AND m.operational_state='in_service'
        AND NOT EXISTS (
          SELECT 1 FROM app.machine_occupancy o
           WHERE o.tenant_id=m.tenant_id AND o.machine_id=m.machine_id AND o.blocking
             AND o.occupancy_range && tstzrange($2::timestamptz,$3::timestamptz,'[)')
        ) ORDER BY m.fleet_number, m.display_name`,
    [categoryLocationId, start, end],
  );
  return { machines: result.rows };
}

export async function getReturnSummaryWorkflow(client, { bookingItemId }) {
  const summary = (await client.query(
    `SELECT t.trip_id, t.started_at, t.ended_at, m.machine_id, m.fleet_number,
            out_i.inspection_id AS outbound_inspection_id, out_i.fuel_pct AS outbound_fuel_pct,
            out_i.odometer_miles AS outbound_odometer_miles,
            in_i.inspection_id AS inbound_inspection_id, in_i.fuel_pct AS inbound_fuel_pct,
            in_i.odometer_miles AS inbound_odometer_miles,
            hold.journal_entry_id AS hold_journal_entry_id, hold.amount_cents AS hold_amount_cents,
            settlement.deposit_hold_settlement_id, settlement.captured_cents, settlement.released_cents,
            settlement.excess_receivable_cents, settlement.settled_at
       FROM app.booking_item bi
       LEFT JOIN app.trip t ON t.tenant_id=bi.tenant_id AND t.booking_item_id=bi.booking_item_id
       LEFT JOIN app.machine m ON m.tenant_id=t.tenant_id AND m.machine_id=t.machine_id
       LEFT JOIN LATERAL (SELECT * FROM app.inspection i WHERE i.tenant_id=bi.tenant_id
                           AND i.booking_item_id=bi.booking_item_id AND i.inspection_type='outbound'
                           AND i.status='completed' ORDER BY i.completed_at DESC LIMIT 1) out_i ON true
       LEFT JOIN LATERAL (SELECT * FROM app.inspection i WHERE i.tenant_id=bi.tenant_id
                           AND i.booking_item_id=bi.booking_item_id AND i.inspection_type='inbound'
                           AND i.status='completed' ORDER BY i.completed_at DESC LIMIT 1) in_i ON true
       LEFT JOIN app.booking_item_deposit_hold hold ON hold.tenant_id=bi.tenant_id
            AND hold.booking_item_id=bi.booking_item_id
       LEFT JOIN app.deposit_hold_settlement settlement ON settlement.tenant_id=bi.tenant_id AND settlement.trip_id=t.trip_id
      WHERE bi.tenant_id=${tenant} AND bi.booking_item_id=$1
      ORDER BY t.started_at DESC NULLS LAST LIMIT 1`, [bookingItemId],
  )).rows[0];
  if (!summary) throw new DomainError("BOOKING_ITEM_NOT_FOUND", 404);
  return { ...summary, isSettled: summary.deposit_hold_settlement_id != null };
}
