import { DomainError } from "./operations-service.js";

const tenant = "app.current_context_tenant_id()";

// Centralized telemetry freshness thresholds. A tenant may override the
// "current" threshold via app.tenant_telemetry_policy.freshness_threshold_seconds;
// "delayed" is a fixed multiple of whatever threshold is in effect so the
// three connectivity buckets (current / delayed / offline) never collapse
// into each other for an unusually small or large tenant-configured value.
export const DEFAULT_FRESHNESS_CURRENT_SECONDS = 300;
export const DELAYED_MULTIPLIER = 6;

function presentMachine(row) {
  return {
    ...row,
    latitude: row.latitude_microdegrees == null ? null : row.latitude_microdegrees / 1_000_000,
    longitude: row.longitude_microdegrees == null ? null : row.longitude_microdegrees / 1_000_000,
    battery_level_bp: row.battery_level_bp == null ? null : Number(row.battery_level_bp),
    lastSeenAgeSeconds: row.last_seen_at == null ? null : Math.max(0, Math.round((Date.now() - new Date(row.last_seen_at).getTime()) / 1000)),
  };
}

const machineSelect = `
  SELECT m.machine_id, m.fleet_number, m.display_name, m.operational_state,
         latest.recorded_at AS last_seen_at, latest.latitude_microdegrees,
         latest.longitude_microdegrees, latest.speed_mph, latest.fuel_pct,
         latest.engine_hours, latest.raw_payload ->> 'batteryLevelBp' AS battery_level_bp,
         active_trip.trip_id AS active_trip_id, active_trip.started_at AS trip_started_at,
         active_trip.scheduled_end_at AS trip_scheduled_end_at, COALESCE(active_trip.is_overdue, false) AS is_overdue,
         upcoming_occupancy.machine_occupancy_id IS NOT NULL AS has_upcoming_assignment,
         open_incident.incident_id AS open_incident_id, open_incident.status AS incident_state,
         open_incident.severity AS highest_open_incident_severity, open_incident.opened_at AS incident_opened_at,
         freshness.freshness_threshold_seconds,
         CASE
           WHEN active_trip.trip_id IS NOT NULL THEN 'on_rent'
           WHEN upcoming_occupancy.machine_occupancy_id IS NOT NULL THEN 'ready'
           ELSE 'unassigned'
         END AS rental_state,
         CASE
           WHEN latest.recorded_at IS NULL THEN 'never_reported'
           WHEN latest.recorded_at >= clock_timestamp() - make_interval(secs => COALESCE(freshness.freshness_threshold_seconds, ${DEFAULT_FRESHNESS_CURRENT_SECONDS})) THEN 'current'
           WHEN latest.recorded_at >= clock_timestamp() - make_interval(secs => COALESCE(freshness.freshness_threshold_seconds, ${DEFAULT_FRESHNESS_CURRENT_SECONDS}) * ${DELAYED_MULTIPLIER}) THEN 'delayed'
           ELSE 'offline'
         END AS connectivity_state,
         CASE
           WHEN m.operational_state = 'in_service' AND active_maintenance.machine_occupancy_id IS NOT NULL THEN 'maintenance'
           WHEN m.operational_state = 'maintenance' THEN 'maintenance'
           WHEN m.operational_state IN ('offline','retired') THEN 'out_of_service'
           ELSE 'in_service'
         END AS service_state
    FROM app.machine m
    LEFT JOIN LATERAL (
      SELECT tf.recorded_at, tf.latitude_microdegrees, tf.longitude_microdegrees,
             tf.speed_mph, tf.fuel_pct, tf.engine_hours, tf.raw_payload
        FROM app.telemetry_frame tf
       WHERE tf.tenant_id=m.tenant_id AND tf.machine_id=m.machine_id
       ORDER BY tf.recorded_at DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT t.trip_id, t.started_at, terms.scheduled_end_at,
             terms.scheduled_end_at < clock_timestamp() AS is_overdue
        FROM app.trip t
        JOIN app.booking_item_terms_revision terms ON terms.tenant_id=t.tenant_id AND terms.booking_item_terms_revision_id=(
          SELECT bi.current_terms_revision_id FROM app.booking_item bi WHERE bi.tenant_id=t.tenant_id AND bi.booking_item_id=t.booking_item_id
        )
       WHERE t.tenant_id=m.tenant_id AND t.machine_id=m.machine_id AND t.ended_at IS NULL
       ORDER BY t.started_at DESC LIMIT 1
    ) active_trip ON true
    LEFT JOIN LATERAL (
      SELECT o.machine_occupancy_id FROM app.machine_occupancy o
       WHERE o.tenant_id=m.tenant_id AND o.machine_id=m.machine_id AND o.occupancy_kind='rental' AND o.blocking
         AND o.occupancy_range && tstzrange(clock_timestamp(), NULL, '[)')
       LIMIT 1
    ) upcoming_occupancy ON true
    LEFT JOIN LATERAL (
      SELECT o.machine_occupancy_id FROM app.machine_occupancy o
       WHERE o.tenant_id=m.tenant_id AND o.machine_id=m.machine_id AND o.occupancy_kind='maintenance' AND o.blocking
         AND o.occupancy_range && tstzrange(clock_timestamp(), NULL, '[)')
       LIMIT 1
    ) active_maintenance ON true
    LEFT JOIN LATERAL (
      SELECT i.incident_id, i.status, i.severity, i.opened_at FROM app.incident i
       WHERE i.tenant_id=m.tenant_id AND i.machine_id=m.machine_id AND i.status <> 'resolved'
       ORDER BY CASE i.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, i.opened_at DESC
       LIMIT 1
    ) open_incident ON true
    LEFT JOIN LATERAL (
      SELECT freshness_threshold_seconds FROM app.tenant_telemetry_policy
       WHERE tenant_id=m.tenant_id ORDER BY version_number DESC LIMIT 1
    ) freshness ON true
   WHERE m.tenant_id=${tenant}`;

export async function getLiveFleetWorkflow(client) {
  const result = await client.query(`${machineSelect} ORDER BY m.fleet_number, m.display_name`);
  const machines = result.rows.map(presentMachine);
  const summary = machines.reduce((accumulator, machine) => {
    accumulator.total += 1;
    if (machine.rental_state === "on_rent") accumulator.onTrip += 1;
    if (machine.is_overdue) accumulator.overdue += 1;
    if (machine.service_state !== "in_service") accumulator.maintenance += 1;
    if (machine.incident_state && machine.incident_state !== "resolved") accumulator.needsAttention += 1;
    if (["delayed", "offline", "never_reported"].includes(machine.connectivity_state)) accumulator.gpsStale += 1;
    return accumulator;
  }, { total: 0, onTrip: 0, overdue: 0, maintenance: 0, needsAttention: 0, gpsStale: 0 });
  return { machines, summary, generatedAt: new Date().toISOString() };
}

export async function getFleetMachineWorkflow(client, { machineId }) {
  const result = await client.query(`${machineSelect} AND m.machine_id=$1`, [machineId]);
  if (!result.rows[0]) throw new DomainError("MACHINE_NOT_FOUND", 404);
  const history = await client.query(
    `SELECT recorded_at, latitude_microdegrees, longitude_microdegrees, speed_mph, fuel_pct, engine_hours,
            raw_payload ->> 'batteryLevelBp' AS battery_level_bp
       FROM app.telemetry_frame
      WHERE tenant_id=${tenant} AND machine_id=$1
      ORDER BY recorded_at DESC LIMIT 60`, [machineId],
  );
  const alerts = await client.query(
    `SELECT fleet_alert_id, alert_kind, severity, triggered_at, payload
       FROM app.fleet_alert
      WHERE tenant_id=${tenant} AND machine_id=$1
      ORDER BY triggered_at DESC LIMIT 20`, [machineId],
  );
  const speedLimit = await client.query(
    `SELECT ol.limit_value, ol.unit_code FROM app.operating_limit ol
       JOIN app.machine m ON m.tenant_id=ol.tenant_id AND m.category_location_id=ol.category_location_id
      WHERE ol.tenant_id=${tenant} AND m.machine_id=$1 AND ol.limit_kind='speed' AND ol.active
      ORDER BY ol.version_number DESC LIMIT 1`, [machineId],
  );
  const speedLimitRow = speedLimit.rows[0];
  const speedLimitMph = speedLimitRow
    ? Math.round(speedLimitRow.unit_code === "kph" ? speedLimitRow.limit_value * 0.621371 : speedLimitRow.limit_value)
    : null;
  return {
    machine: presentMachine(result.rows[0]),
    telemetryHistory: history.rows.reverse().map(presentMachine),
    alerts: alerts.rows,
    speedLimitMph,
    generatedAt: new Date().toISOString(),
  };
}

// Raw telemetry-triggered alert log, preserved for audit/history use. The
// fleet UI's primary incident-response surface is /api/v1/fleet/incidents
// (see incident-service.js), which groups these into a mutable lifecycle.
export async function getFleetAlertsWorkflow(client) {
  const result = await client.query(
    `SELECT a.fleet_alert_id, a.machine_id, a.alert_kind, a.severity, a.triggered_at, a.payload,
            m.fleet_number, m.display_name
       FROM app.fleet_alert a
       JOIN app.machine m ON m.tenant_id=a.tenant_id AND m.machine_id=a.machine_id
      WHERE a.tenant_id=${tenant}
      ORDER BY CASE a.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
               a.triggered_at DESC
      LIMIT 100`,
  );
  return { alerts: result.rows, generatedAt: new Date().toISOString() };
}

export async function getFleetGeofencesWorkflow(client) {
  const result = await client.query(
    `SELECT geofence_id, display_name, geometry
       FROM app.geofence WHERE tenant_id=${tenant} AND active ORDER BY display_name`,
  );
  return { geofences: result.rows, generatedAt: new Date().toISOString() };
}
