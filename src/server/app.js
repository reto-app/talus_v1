import Fastify from "fastify";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { tenantContextPlugin } from "./plugins/tenant-context.js";
import { withTenantTransaction } from "../db/transaction.js";
import { generateQuote,createBookingWorkflow,executeWaiverWorkflow,getDispatchReadinessWorkflow } from "../services/booking-service.js";
import { operationsRoutes } from "./routes/operations-routes.js";
import { telemetryRoutes } from "./routes/telemetry-routes.js";
import { healthRoutes } from "./routes/health-routes.js";
import { opsRoutes } from "./routes/ops-routes.js";
import { inspectionRoutes } from "./routes/inspection-routes.js";
import { depositRoutes } from "./routes/deposit-routes.js";
export async function buildApp(pool,fastifyFactory=Fastify) {
  const app = fastifyFactory();
  app.decorate("talusReadiness", { isShuttingDown: false });
  await app.register(sensible);
  await app.register(swagger, {
    openapi: {
      info: { title: "Talus API", description: "Tenant-scoped rental operations API", version: "1.0.0" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "UUID context assertion" },
        tenantContext: { type: "apiKey", in: "header", name: "x-tenant-id" },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: true } });
  await tenantContextPlugin(app);
  await healthRoutes(app,{pool,readiness:app.talusReadiness});
  await app.register(opsRoutes,{pool});
  const tx=(r,fn)=>withTenantTransaction(pool,r.talusContext,fn);
  app.post("/api/v1/quotes",async(r)=>tx(r,c=>generateQuote(c,r.body)));
  app.post("/api/v1/bookings",async(r,reply)=>{if(r.talusContext.actorKind==="customer")return reply.forbidden();return reply.code(201).send(await tx(r,c=>createBookingWorkflow(c,r.body)))});
  app.post("/api/v1/bookings/:bookingItemId/waivers",async(r,reply)=>{if(r.talusContext.actorKind==="customer")return reply.forbidden();return reply.code(201).send(await tx(r,c=>executeWaiverWorkflow(c,{bookingItemId:r.params.bookingItemId,...r.body})))});
  app.get("/api/v1/bookings/:bookingItemId/dispatch-readiness",async(r)=>tx(r,c=>getDispatchReadinessWorkflow(c,{bookingItemId:r.params.bookingItemId})));
  await app.register(operationsRoutes,{pool});
  await app.register(telemetryRoutes,{pool});
  await app.register(inspectionRoutes,{pool});
  await app.register(depositRoutes,{pool});
  return app;
}
