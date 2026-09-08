import { withTenantTransaction } from "../../db/transaction.js";
import { DomainError } from "../../services/operations-service.js";
import {
  acknowledgeIncidentWorkflow,
  addIncidentNoteWorkflow,
  getIncidentWorkflow,
  listIncidentsWorkflow,
  resolveIncidentWorkflow,
  startIncidentResponseWorkflow,
} from "../../services/incident-service.js";

export async function incidentRoutes(app, { pool }) {
  const permitted = (request) => ["staff", "api"].includes(request.talusContext.actorKind);
  const read = (workflow) => async (request, reply) => {
    if (!permitted(request)) return reply.forbidden();
    try {
      return await withTenantTransaction(pool, request.talusContext, (client) => workflow(client, { ...request.params, ...request.query }));
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  };
  const write = (workflow) => async (request, reply) => {
    if (!permitted(request)) return reply.forbidden();
    try {
      return await withTenantTransaction(pool, request.talusContext, (client) => workflow(client, { ...request.params, ...request.body }));
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  };

  app.get("/api/v1/fleet/incidents", read(listIncidentsWorkflow));
  app.get("/api/v1/fleet/incidents/:incidentId", read(getIncidentWorkflow));
  app.post("/api/v1/fleet/incidents/:incidentId/acknowledge", write(acknowledgeIncidentWorkflow));
  app.post("/api/v1/fleet/incidents/:incidentId/start", write(startIncidentResponseWorkflow));
  app.post("/api/v1/fleet/incidents/:incidentId/resolve", write(resolveIncidentWorkflow));
  app.post("/api/v1/fleet/incidents/:incidentId/notes", write(addIncidentNoteWorkflow));
}
