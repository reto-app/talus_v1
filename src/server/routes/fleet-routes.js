import { readFile } from "node:fs/promises";
import { withTenantTransaction } from "../../db/transaction.js";
import { DomainError } from "../../services/operations-service.js";
import {
  getFleetAlertsWorkflow,
  getFleetGeofencesWorkflow,
  getFleetMachineWorkflow,
  getLiveFleetWorkflow,
} from "../../services/fleet-service.js";

export async function fleetRoutes(app, { pool }) {
  const permitted = (request) => ["staff", "api"].includes(request.talusContext.actorKind);
  const read = (workflow) => async (request, reply) => {
    if (!permitted(request)) return reply.forbidden();
    try {
      return await withTenantTransaction(pool, request.talusContext, (client) => workflow(client, {
        ...request.params,
        ...request.query,
      }));
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  };

  app.get("/fleet", async (_request, reply) => reply.type("text/html; charset=utf-8").send(
    await readFile(new URL("../public/fleet.html", import.meta.url), "utf8"),
  ));
  app.get("/assets/talus-logo.png", async (_request, reply) => reply.type("image/png").send(
    await readFile(new URL("../public/assets/talus-logo.png", import.meta.url)),
  ));
  app.get("/api/v1/fleet/live", read(getLiveFleetWorkflow));
  app.get("/api/v1/fleet/alerts", read(getFleetAlertsWorkflow));
  app.get("/api/v1/fleet/geofences", read(getFleetGeofencesWorkflow));
  app.get("/api/v1/fleet/machines/:machineId", read(getFleetMachineWorkflow));
}
