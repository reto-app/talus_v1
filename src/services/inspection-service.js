import { DomainError } from "./operations-service.js";

const SQL_ERROR_CODES = {
  INSPECTION_ITEM_OUTCOME_REQUIRED: 422,
  INSPECTION_INPUT_INVALID: 422,
  INSPECTION_CHECKLIST_INCOMPLETE: 422,
  FUEL_READING_REQUIRED: 422,
  INSPECTION_NOT_COMPLETABLE: 409,
};

// A post-rental (inbound) inspection can be recorded either while the item
// is still on rent or any time after physical return has ended the trip --
// physical return is unconditional and never waits on this inspection, so
// the inspection must be attachable to the trip regardless of whether it
// has already been sealed.

export const REQUIRED_INSPECTION_COMPONENTS = ["tires", "brakes", "body_panels", "safety_gear"];

export async function createInspectionWorkflow(client, {
  bookingItemId, machineId, type, fuelLevelPct = null, odometerMiles = null,
  fuelUnavailableReason = null, odometerUnavailableReason = null,
  notes = "", checkItems = [], requiredComponents = REQUIRED_INSPECTION_COMPONENTS,
}) {
  const trip = type === "inbound"
    ? (await client.query("SELECT trip_id FROM app.trip WHERE tenant_id=app.current_context_tenant_id() AND booking_item_id=$1 ORDER BY started_at DESC LIMIT 1", [bookingItemId])).rows[0]
    : null;
  if (type === "inbound" && !trip) throw new DomainError("NO_TRIP_FOUND", 409);
  try {
    const row = (await client.query(
      "SELECT app.create_completed_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS inspection_id",
      [
        bookingItemId, machineId, trip?.trip_id ?? null, type, fuelLevelPct, odometerMiles, notes,
        JSON.stringify(checkItems), fuelUnavailableReason, odometerUnavailableReason, requiredComponents,
      ],
    )).rows[0];
    const unsafe = checkItems.some((item) => item.outcome === "unsafe");
    return { inspectionId: row.inspection_id, status: "sealed", type, fuelLevelPct, odometerMiles, unsafe };
  } catch (error) {
    const code = error.message?.match(/^([A-Z_]+)$/)?.[1] ?? error.code;
    if (SQL_ERROR_CODES[code]) throw new DomainError(code, SQL_ERROR_CODES[code]);
    throw error;
  }
}
