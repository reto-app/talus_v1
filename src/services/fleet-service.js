import { DomainError } from "./operations-service.js";

const tenant = "app.current_context_tenant_id()";

function presentMachine(row) {
  return {
    ...row,
    latitude: row.latitude_microdegrees == null ? null : row.latitude_microdegrees / 1_000_000,
    longitude: row.longitude_microdegrees == null ? null : row.longitude_microdegrees / 1_000_000,
    battery_level_bp: row.battery_level_bp == null ? null : Number(row.battery_level_bp),
  };
}

const machineSelect = `
  SELECT m.machine_id, m.fleet_number, m.display_name, m.operational_state,
         latest.recorded_at AS last_seen_at, latest.latitude_microdegrees,
         latest.longitude_microdegrees, latest.speed_mph, latest.fuel_pct,
         latest.engine_hours, latest.raw_payload ->> 'batteryLevelBp' AS battery_level_bp,
         active_trip.trip_id AS active_trip_id, active_trip.started_at AS trip_started_at,
         active_alert.fleet_alert_id AS alert_id, active_alert.alert_kind,
         active_alert.severity AS alert_severity, active_alert.triggered_at AS alert_triggered_at,
         active_alert.payload AS alert_payload,
         CASE
           WHEN m.operational_state <> 'in_service' THEN 'maintenance'
           WHEN active_alert.severity IN ('critical', 'high') THEN 'critical'
           WHEN active_alert.severity IN ('medium', 'low') THEN 'warning'
           WHEN active_trip.trip_id IS NOT NULL THEN 'on_trip'
           WHEN latest.recorded_at IS NULL OR latest.recorded_at < clock_timestamp() - interval '30 minutes' THEN 'offline'
           ELSE 'ready'
         END AS marker_state
    FROM app.machine m
    LEFT JOIN LATERAL (
      SELECT tf.recorded_at, tf.latitude_microdegrees, tf.longitude_microdegrees,
             tf.speed_mph, tf.fuel_pct, tf.engine_hours, tf.raw_payload
        FROM app.telemetry_frame tf
       WHERE tf.tenant_id=m.tenant_id AND tf.machine_id=m.machine_id
       ORDER BY tf.recorded_at DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT t.trip_id, t.started_at FROM app.trip t
       WHERE t.tenant_id=m.tenant_id AND t.machine_id=m.machine_id AND t.ended_at IS NULL
       ORDER BY t.started_at DESC LIMIT 1
    ) active_trip ON true
    LEFT JOIN LATERAL (
      SELECT a.fleet_alert_id, a.alert_kind, a.severity, a.triggered_at, a.payload
        FROM app.fleet_alert a
       WHERE a.tenant_id=m.tenant_id AND a.machine_id=m.machine_id
       ORDER BY CASE a.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                a.triggered_at DESC
       LIMIT 1
    ) active_alert ON true
   WHERE m.tenant_id=${tenant}`;

export async function getLiveFleetWorkflow(client) {
  const result = await client.query(`${machineSelect} ORDER BY m.fleet_number, m.display_name`);
  const machines = result.rows.map(presentMachine);
  const summary = machines.reduce((accumulator, machine) => {
    accumulator.total += 1;
    if (machine.marker_state === "on_trip") accumulator.onTrip += 1;
    if (machine.marker_state === "maintenance") accumulator.maintenance += 1;
    if (["warning", "critical"].includes(machine.marker_state)) accumulator.attention += 1;
    return accumulator;
  }, { total: 0, onTrip: 0, maintenance: 0, attention: 0 });
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
  return {
    machine: presentMachine(result.rows[0]),
    telemetryHistory: history.rows.reverse().map(presentMachine),
    alerts: alerts.rows,
  };
}

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
  return { alerts: result.rows };
}

export async function getFleetGeofencesWorkflow(client) {
  const result = await client.query(
    `SELECT geofence_id, display_name, geometry
       FROM app.geofence WHERE tenant_id=${tenant} AND active ORDER BY display_name`,
  );
  return { geofences: result.rows };
}
