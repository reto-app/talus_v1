import { DomainError } from "./operations-service.js";

const tenant = "app.current_context_tenant_id()";

const SQL_ERROR_CODES = {
  INCIDENT_NOT_FOUND: 404,
  INCIDENT_STATE_INVALID: 409,
  INCIDENT_RESOLUTION_REASON_REQUIRED: 422,
};

function mapIncidentError(error) {
  const code = error.message?.match(/^([A-Z_]+)$/)?.[1];
  return code && SQL_ERROR_CODES[code] ? new DomainError(code, SQL_ERROR_CODES[code]) : null;
}

const incidentSelect = `
  SELECT i.tenant_id, i.incident_id, i.machine_id, i.status, i.severity, i.opened_at,
         i.acknowledged_at, i.in_progress_at, i.resolved_at, i.resolution_reason, i.updated_at,
         i.assigned_principal_id, staff.display_name AS assigned_display_name,
         m.fleet_number, m.display_name AS machine_display_name,
         latest.alert_kind, latest.triggered_at AS last_alert_at,
         (SELECT count(*) FROM app.incident_alert ia WHERE ia.tenant_id = i.tenant_id AND ia.incident_id = i.incident_id) AS alert_count,
         (SELECT count(*) FROM app.incident_note n WHERE n.tenant_id = i.tenant_id AND n.incident_id = i.incident_id) AS note_count
    FROM app.incident i
    JOIN app.machine m ON m.tenant_id = i.tenant_id AND m.machine_id = i.machine_id
    LEFT JOIN app.principal p ON p.tenant_id = i.tenant_id AND p.principal_id = i.assigned_principal_id
    LEFT JOIN app.staff_user staff ON staff.tenant_id = p.tenant_id AND staff.staff_user_id = p.staff_user_id
    LEFT JOIN LATERAL (
      SELECT a.alert_kind, a.triggered_at FROM app.incident_alert ia
        JOIN app.fleet_alert a ON a.tenant_id = ia.tenant_id AND a.fleet_alert_id = ia.fleet_alert_id
       WHERE ia.tenant_id = i.tenant_id AND ia.incident_id = i.incident_id
       ORDER BY a.triggered_at DESC LIMIT 1
    ) latest ON true
   WHERE i.tenant_id = ${tenant}`;

export async function listIncidentsWorkflow(client, { status = "open" } = {}) {
  const statusFilter = status === "all" ? "" : status === "resolved" ? "AND i.status = 'resolved'" : "AND i.status <> 'resolved'";
  const result = await client.query(`${incidentSelect} ${statusFilter} ORDER BY CASE i.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, i.opened_at DESC`);
  return { incidents: result.rows, generatedAt: new Date().toISOString() };
}

export async function getIncidentWorkflow(client, { incidentId }) {
  const incident = (await client.query(`${incidentSelect} AND i.incident_id = $1`, [incidentId])).rows[0];
  if (!incident) throw new DomainError("INCIDENT_NOT_FOUND", 404);
  const alerts = await client.query(
    `SELECT a.fleet_alert_id, a.alert_kind, a.severity, a.triggered_at, a.payload
       FROM app.incident_alert ia
       JOIN app.fleet_alert a ON a.tenant_id = ia.tenant_id AND a.fleet_alert_id = ia.fleet_alert_id
      WHERE ia.tenant_id = ${tenant} AND ia.incident_id = $1
      ORDER BY a.triggered_at DESC`,
    [incidentId],
  );
  const notes = await client.query(
    `SELECT n.incident_note_id, n.body, n.created_at, staff.display_name AS author_display_name
       FROM app.incident_note n
       JOIN app.principal p ON p.tenant_id = n.tenant_id AND p.principal_id = n.author_principal_id
       LEFT JOIN app.staff_user staff ON staff.tenant_id = p.tenant_id AND staff.staff_user_id = p.staff_user_id
      WHERE n.tenant_id = ${tenant} AND n.incident_id = $1
      ORDER BY n.created_at DESC`,
    [incidentId],
  );
  const statusHistory = await client.query(
    `SELECT e.from_status, e.to_status, e.occurred_at, e.reason, staff.display_name AS actor_display_name
       FROM app.incident_status_event e
       JOIN app.principal p ON p.tenant_id = e.tenant_id AND p.principal_id = e.actor_principal_id
       LEFT JOIN app.staff_user staff ON staff.tenant_id = p.tenant_id AND staff.staff_user_id = p.staff_user_id
      WHERE e.tenant_id = ${tenant} AND e.incident_id = $1
      ORDER BY e.occurred_at ASC`,
    [incidentId],
  );
  return { incident, alerts: alerts.rows, notes: notes.rows, statusHistory: statusHistory.rows };
}

export async function acknowledgeIncidentWorkflow(client, { incidentId, assignToPrincipalId = null }) {
  try {
    await client.query("SELECT app.acknowledge_incident($1,$2)", [incidentId, assignToPrincipalId]);
  } catch (error) {
    throw mapIncidentError(error) ?? error;
  }
  return getIncidentWorkflow(client, { incidentId });
}

export async function startIncidentResponseWorkflow(client, { incidentId, assignToPrincipalId = null }) {
  try {
    await client.query("SELECT app.start_incident_response($1,$2)", [incidentId, assignToPrincipalId]);
  } catch (error) {
    throw mapIncidentError(error) ?? error;
  }
  return getIncidentWorkflow(client, { incidentId });
}

export async function resolveIncidentWorkflow(client, { incidentId, resolutionReason }) {
  try {
    await client.query("SELECT app.resolve_incident($1,$2)", [incidentId, resolutionReason]);
  } catch (error) {
    throw mapIncidentError(error) ?? error;
  }
  return getIncidentWorkflow(client, { incidentId });
}

export async function addIncidentNoteWorkflow(client, { incidentId, body }) {
  try {
    await client.query("SELECT app.add_incident_note($1,$2)", [incidentId, body]);
  } catch (error) {
    throw mapIncidentError(error) ?? error;
  }
  return getIncidentWorkflow(client, { incidentId });
}
