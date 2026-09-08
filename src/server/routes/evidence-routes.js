import { createReadStream } from "node:fs";
import multipart from "@fastify/multipart";
import { withTenantTransaction } from "../../db/transaction.js";
import { DomainError } from "../../services/operations-service.js";
import { readEvidenceFileWorkflow, storeInspectionPhotoWorkflow } from "../../services/evidence-service.js";

export async function evidenceRoutes(app, { pool }) {
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  app.post("/api/v1/inspections/photos", async (request, reply) => {
    if (!["staff", "api"].includes(request.talusContext.actorKind)) return reply.forbidden();
    const file = await request.file();
    if (!file) return reply.code(422).send({ code: "EVIDENCE_FILE_MISSING" });
    try {
      const result = await withTenantTransaction(pool, request.talusContext, (client) => storeInspectionPhotoWorkflow(client, {
        tenantId: request.talusContext.tenantId,
        mimeType: file.mimetype,
        fileStream: file.file,
      }));
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  app.get("/api/v1/evidence/:evidenceFileId", async (request, reply) => {
    if (!["staff", "api"].includes(request.talusContext.actorKind)) return reply.forbidden();
    try {
      const { absolutePath, contentType } = await withTenantTransaction(pool, request.talusContext, (client) => readEvidenceFileWorkflow(client, request.params));
      reply.type(contentType);
      return reply.send(createReadStream(absolutePath));
    } catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });
}
