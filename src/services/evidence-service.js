import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DomainError } from "./operations-service.js";

const EVIDENCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../var/evidence-store");
const MAX_BYTES = 15 * 1024 * 1024;
const EXTENSION_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function storeInspectionPhotoWorkflow(client, { tenantId, mimeType, fileStream }) {
  if (!EXTENSION_BY_TYPE[mimeType]) throw new DomainError("EVIDENCE_CONTENT_TYPE_UNSUPPORTED", 422);
  const evidenceFileId = crypto.randomUUID();
  const storageKey = `${tenantId}/${evidenceFileId}.${EXTENSION_BY_TYPE[mimeType]}`;
  const absolutePath = path.join(EVIDENCE_ROOT, storageKey);
  await mkdirAsync(path.dirname(absolutePath), { recursive: true });

  let byteSize = 0;
  fileStream.on("data", (chunk) => { byteSize += chunk.length; });
  try {
    await pipeline(fileStream, createWriteStream(absolutePath));
  } catch (error) {
    throw new DomainError("EVIDENCE_UPLOAD_FAILED", 422);
  }
  if (byteSize === 0 || byteSize > MAX_BYTES) throw new DomainError("EVIDENCE_FILE_SIZE_INVALID", 422);

  await client.query("SELECT app.record_evidence_file($1,$2,$3,$4)", [evidenceFileId, mimeType, byteSize, storageKey]);
  return { evidenceFileId };
}

export async function readEvidenceFileWorkflow(client, { evidenceFileId }) {
  const row = (await client.query(
    "SELECT storage_key, content_type FROM app.evidence_file WHERE tenant_id=app.current_context_tenant_id() AND evidence_file_id=$1",
    [evidenceFileId],
  )).rows[0];
  if (!row) throw new DomainError("EVIDENCE_NOT_FOUND", 404);
  return { absolutePath: path.join(EVIDENCE_ROOT, row.storage_key), contentType: row.content_type };
}
