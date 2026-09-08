import { withTenantTransaction } from "../../db/transaction.js";
import { DomainError } from "../../services/operations-service.js";
import { loginStaffWorkflow, logoutStaffSessionWorkflow, refreshStaffSessionWorkflow } from "../../services/auth-service.js";

export async function authRoutes(app, { pool }) {
  app.post("/auth/login", async (request, reply) => {
    try {
      const session = await loginStaffWorkflow(pool, request.body ?? {});
      return session;
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    if (request.talusContext.actorKind !== "staff") return reply.forbidden();
    try {
      return await withTenantTransaction(pool, request.talusContext, (client) => refreshStaffSessionWorkflow(client));
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    if (request.talusContext.actorKind !== "staff") return reply.forbidden();
    return withTenantTransaction(pool, request.talusContext, (client) => logoutStaffSessionWorkflow(client));
  });
}
