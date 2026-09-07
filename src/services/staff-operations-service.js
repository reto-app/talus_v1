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
     )
     SELECT
       EXISTS (SELECT 1 FROM app.machine_occupancy o
                WHERE o.tenant_id=${tenant} AND o.booking_item_id=$1
                  AND o.occupancy_kind='rental' AND o.blocking) AS assignment_ready,
       EXISTS (SELECT 1 FROM app.booking_item_deposit_hold h
                WHERE h.tenant_id=${tenant} AND h.booking_item_id=$1) AS deposit_ready,
       EXISTS (SELECT 1 FROM app.inspection i
                WHERE i.tenant_id=${tenant} AND i.booking_item_id=$1
                  AND i.inspection_type='outbound' AND i.status='completed'
                  AND ($2::uuid IS NULL OR i.inspection_id=$2)) AS outbound_inspection_ready,
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
  ].filter(Boolean);
  return { isReady: missingRequirements.length === 0, missingRequirements, ...gate };
}

export async function assertDispatchGateWorkflow(client, input) {
  const gate = await getDispatchGateWorkflow(client, input);
  if (!gate.isReady) throw new DomainError("DISPATCH_GATE_INCOMPLETE", 422, gate);
  return gate;
}

export async function getDispatchBoardWorkflow(client, { date } = {}) {
  const rows = await client.query(
    `SELECT bi.booking_item_id, b.booking_id, b.booking_reference, b.state AS booking_state,
            bi.state AS booking_item_state, terms.category_location_id, terms.scheduled_start_at, terms.scheduled_end_at,
            customer.display_name AS customer_name, product.display_name AS product_name,
            assignment.machine_id, assignment.fleet_number,
            EXISTS (SELECT 1 FROM app.booking_item_deposit_hold h
                     WHERE h.tenant_id=b.tenant_id AND h.booking_item_id=bi.booking_item_id) AS deposit_ready,
            EXISTS (SELECT 1 FROM app.inspection i WHERE i.tenant_id=b.tenant_id
                     AND i.booking_item_id=bi.booking_item_id AND i.inspection_type='outbound'
                     AND i.status='completed') AS outbound_inspection_ready,
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
            EXISTS (SELECT 1 FROM app.trip t WHERE t.tenant_id=b.tenant_id
                     AND t.booking_item_id=bi.booking_item_id AND t.ended_at IS NULL) AS active_trip
       FROM app.booking_item bi
       JOIN app.booking b ON b.tenant_id=bi.tenant_id AND b.booking_id=bi.booking_id
       JOIN app.booking_item_terms_revision terms ON terms.tenant_id=bi.tenant_id
            AND terms.booking_item_terms_revision_id=bi.current_terms_revision_id
       LEFT JOIN app.booking_customer bc ON bc.tenant_id=b.tenant_id AND bc.booking_id=b.booking_id
       LEFT JOIN app.customer customer ON customer.tenant_id=bc.tenant_id AND customer.customer_id=bc.customer_id
       LEFT JOIN app.rental_product product ON product.tenant_id=terms.tenant_id
            AND product.category_location_id=terms.category_location_id AND product.active
       LEFT JOIN LATERAL (
         SELECT o.machine_id, m.fleet_number FROM app.machine_occupancy o
         JOIN app.machine m ON m.tenant_id=o.tenant_id AND m.machine_id=o.machine_id
         WHERE o.tenant_id=bi.tenant_id AND o.booking_item_id=bi.booking_item_id
           AND o.occupancy_kind='rental' AND o.blocking LIMIT 1
       ) assignment ON true
      WHERE b.tenant_id=${tenant}
        AND ($1::date IS NULL OR terms.scheduled_start_at >= $1::date
             AND terms.scheduled_start_at < ($1::date + interval '1 day'))
      ORDER BY terms.scheduled_start_at, bi.booking_item_id`,
    [date ?? null],
  );
  return { items: rows.rows };
}

export async function getBookingItemWorkflow(client, { bookingItemId }) {
  const board = await getDispatchBoardWorkflow(client, {});
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
            hold.journal_entry_id AS hold_journal_entry_id, hold.amount_cents AS hold_amount_cents
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
      WHERE bi.tenant_id=${tenant} AND bi.booking_item_id=$1
      ORDER BY t.started_at DESC NULLS LAST LIMIT 1`, [bookingItemId],
  )).rows[0];
  if (!summary) throw new DomainError("BOOKING_ITEM_NOT_FOUND", 404);
  return summary;
}
