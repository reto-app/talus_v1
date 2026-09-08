import { withTenantTransaction } from "../../db/transaction.js";
import {
  assignMachineWorkflow,
  closeBookingItemWorkflow,
  closeBookingWorkflow,
  DomainError,
  dispatchBookingItemWorkflow,
  returnBookingItemWorkflow,
} from "../../services/operations-service.js";
import { settleTripChargesWorkflow } from "../../services/settlement-service.js";
import {
  getAvailableMachinesWorkflow,
  getBookingItemWorkflow,
  getDispatchBoardWorkflow,
  getReturnSummaryWorkflow,
} from "../../services/staff-operations-service.js";

export async function operationsRoutes(app, { pool }) {
  const allowed = (request) => ["staff", "api"].includes(request.talusContext.actorKind);
  const respondError = (error, reply) => (error instanceof DomainError
    ? reply.code(error.status).send({ code: error.code, ...(error.details ? { details: error.details } : {}) })
    : null);

  // Write action: input comes from the request body only.
  const write = (workflow) => async (request, reply) => {
    if (!allowed(request)) return reply.forbidden();
    try {
      return await withTenantTransaction(pool, request.talusContext, (client) => workflow(client, request.body));
    } catch (error) {
      const response = respondError(error, reply);
      if (response) return response;
      throw error;
    }
  };

  // Read, or a write whose target comes from the URL (e.g. .../:id/close):
  // params and body are merged, body wins on key collisions.
  const read = (workflow) => async (request, reply) => {
    if (!allowed(request)) return reply.forbidden();
    try {
      return await withTenantTransaction(pool, request.talusContext, (client) => workflow(client, { ...request.params, ...request.query, ...request.body }));
    } catch (error) {
      const response = respondError(error, reply);
      if (response) return response;
      throw error;
    }
  };

  app.get("/api/v1/operations/dispatch-board", read(getDispatchBoardWorkflow));
  app.get("/api/v1/operations/booking-items/:bookingItemId", read(getBookingItemWorkflow));
  app.get("/api/v1/operations/machines", read(getAvailableMachinesWorkflow));
  app.get("/api/v1/operations/booking-items/:bookingItemId/return-summary", read(getReturnSummaryWorkflow));
  app.post("/api/v1/operations/assign", write(assignMachineWorkflow));
  app.post("/api/v1/operations/dispatch", write(dispatchBookingItemWorkflow));
  app.post("/api/v1/operations/return", write(returnBookingItemWorkflow));
  app.post("/api/v1/operations/settle", write(settleTripChargesWorkflow));
  app.post("/api/v1/operations/booking-items/:bookingItemId/close", read(closeBookingItemWorkflow));
  app.post("/api/v1/operations/bookings/:bookingId/close", read(closeBookingWorkflow));
}
