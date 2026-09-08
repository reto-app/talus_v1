export class DomainError extends Error {
  constructor(code, status, details) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const SQL_ERROR_CODES = {
  DISPATCH_GATE_FAILED: 422,
  DISPATCH_STATE_INVALID: 409,
  DISPATCH_BLOCKED_UNSAFE_INSPECTION: 422,
};

function mapSqlError(error) {
  const code = error.message?.match(/^([A-Z_]+)$/)?.[1];
  return code && SQL_ERROR_CODES[code] ? new DomainError(code, SQL_ERROR_CODES[code]) : null;
}

export async function assignMachineWorkflow(client, { bookingItemId, machineId }) {
  const termsRow = await client.query(
    "SELECT current_terms_revision_id FROM app.booking_item WHERE booking_item_id=$1",
    [bookingItemId],
  );
  const termsRevisionId = termsRow.rows[0]?.current_terms_revision_id;
  if (!termsRevisionId) throw new DomainError("NO_ACTIVE_TERMS_REVISION", 422);
  try {
    const result = await client.query(
      "SELECT app.assign_machine_to_booking_item($1,$2,$3) assignment_id",
      [machineId, bookingItemId, termsRevisionId],
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === "23P01") throw new DomainError("MACHINE_OCCUPIED", 409);
    throw error;
  }
}

export async function dispatchBookingItemWorkflow(client, { bookingItemId, outboundInspectionId, dispatchedAt }) {
  const { assertDispatchGateWorkflow } = await import("./staff-operations-service.js");
  await assertDispatchGateWorkflow(client, { bookingItemId, outboundInspectionId });

  const occupancy = (await client.query(
    `SELECT machine_occupancy_id, machine_id FROM app.machine_occupancy
      WHERE tenant_id=app.current_context_tenant_id() AND booking_item_id=$1
        AND occupancy_kind='rental' AND blocking LIMIT 1`,
    [bookingItemId],
  )).rows[0];
  if (!occupancy) throw new DomainError("MACHINE_NOT_ASSIGNED", 409);

  const inspection = (await client.query(
    `SELECT inspection_id FROM app.inspection
      WHERE tenant_id=app.current_context_tenant_id() AND booking_item_id=$1 AND machine_id=$2
        AND inspection_type='outbound' AND status='completed'
        AND ($3::uuid IS NULL OR inspection_id=$3)
      ORDER BY completed_at DESC LIMIT 1`,
    [bookingItemId, occupancy.machine_id, outboundInspectionId ?? null],
  )).rows[0];
  if (!inspection) throw new DomainError("OUTBOUND_INSPECTION_REQUIRED", 422);

  const unsafeItem = (await client.query(
    `SELECT 1 FROM app.inspection_item WHERE tenant_id=app.current_context_tenant_id() AND inspection_id=$1 AND condition='fail' LIMIT 1`,
    [inspection.inspection_id],
  )).rows[0];
  if (unsafeItem) throw new DomainError("DISPATCH_BLOCKED_UNSAFE_INSPECTION", 422);

  try {
    const result = await client.query(
      "SELECT app.dispatch_booking_item($1,$2,$3,$4) trip_id",
      [bookingItemId, occupancy.machine_occupancy_id, inspection.inspection_id, dispatchedAt],
    );
    return result.rows[0];
  } catch (error) {
    throw mapSqlError(error) ?? error;
  }
}

export async function returnBookingItemWorkflow(client, { bookingItemId, inboundInspectionId, returnedAt, fuelChargeCents = 0, excessMileageCents = 0 }) {
  const trip = (await client.query(
    `SELECT trip_id, machine_id FROM app.trip
      WHERE tenant_id=app.current_context_tenant_id() AND booking_item_id=$1 AND ended_at IS NULL LIMIT 1`,
    [bookingItemId],
  )).rows[0];
  if (!trip) throw new DomainError("NO_ACTIVE_TRIP", 409);

  const inspection = (await client.query(
    `SELECT inspection_id FROM app.inspection
      WHERE tenant_id=app.current_context_tenant_id() AND booking_item_id=$1 AND machine_id=$2 AND trip_id=$3
        AND inspection_type='inbound' AND status='completed'
        AND ($4::uuid IS NULL OR inspection_id=$4)
      ORDER BY completed_at DESC LIMIT 1`,
    [bookingItemId, trip.machine_id, trip.trip_id, inboundInspectionId ?? null],
  )).rows[0];
  if (!inspection) throw new DomainError("INBOUND_INSPECTION_REQUIRED", 422);

  const result = await client.query(
    "SELECT app.receive_booking_return($1,$2,$3,$4,$5,$6) trip_id",
    [bookingItemId, trip.trip_id, inspection.inspection_id, returnedAt, fuelChargeCents, excessMileageCents],
  );
  return result.rows[0];
}
