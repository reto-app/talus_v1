export async function tenantContextPlugin(fastify) {
  fastify.decorateRequest("talusContext", null);
  fastify.addHook("onRequest", async (request, reply) => {
    // Health probes intentionally remain outside the authenticated tenant API.
    if (request.url.startsWith("/health/") || request.url.startsWith("/docs") || request.url.startsWith("/ops") || request.url.startsWith("/book") || request.url.startsWith("/waiver/") || request.url.includes("/waiver-context")) return;
    const tenantId = request.headers["x-tenant-id"];
    const actorKind = request.headers["x-actor-kind"];
    const actorId = request.headers["x-actor-id"];
    const bearerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!tenantId || !actorKind || !bearerToken) return reply.code(401).send({ error: "authentication_required" });
    request.talusContext = {
      tenantId: String(tenantId),
      actorKind: String(actorKind),
      actorId: actorId ? String(actorId) : undefined,
      customerId: request.headers["x-customer-id"] ? String(request.headers["x-customer-id"]) : undefined,
      locationId: request.headers["x-location-id"] ? String(request.headers["x-location-id"]) : undefined,
      assertionToken: bearerToken,
    };
  });
}
