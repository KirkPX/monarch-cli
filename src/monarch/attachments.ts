// Attach a file (a receipt) to a transaction: ask Monarch for an upload ticket,
// upload the file to Monarch's image host, then tell Monarch the file's id.

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ApiClient } from "../client.js";
import { uploadFile, type UploadOptions, type UploadTicket } from "../client-upload.js";
import { ApiError, UsageError } from "../errors.js";
import { payload } from "./payload.js";

export type Attachment = {
  id: string;
  publicId: string;
  extension: string;
  sizeBytes: number;
  filename: string;
  originalAssetUrl: string | null;
};

const TICKET = `mutation Common_GetTransactionAttachmentUploadInfo($transactionId: UUID!) {
  getTransactionAttachmentUploadInfo(transactionId: $transactionId) {
    info { path requestParams { timestamp folder signature api_key upload_preset } } } }`;

const ADD = `mutation Common_AddTransactionAttachment($input: TransactionAddAttachmentMutationInput!) {
  addTransactionAttachment(input: $input) {
    attachment { id publicId extension sizeBytes filename originalAssetUrl }
    errors { message code fieldErrors { field messages } } } }`;

const LIST = `query GetTransactionAttachments($id: UUID!) { getTransaction(id: $id) {
  id attachments { id publicId extension sizeBytes filename originalAssetUrl } } }`;

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

export async function readAttachmentFile(path: string): Promise<{ name: string; type: string; data: Uint8Array }> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UsageError(`Cannot read "${path}": ${code === "ENOENT" ? "the file does not exist" : code === "EACCES" ? "you do not have permission to read it" : code}.`);
  }
  if (info.isDirectory()) throw new UsageError(`Cannot read "${path}": it is a folder, not a file.`);
  if (info.size === 0) throw new UsageError(`"${path}" is empty.`);
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) {
    throw new UsageError(`Monarch takes images and PDFs as attachments, not "${extname(path) || "a file with no extension"}".`, `Accepted: ${Object.keys(TYPES).join(", ")}.`);
  }
  return { name: basename(path), type, data: new Uint8Array(await readFile(path)) };
}

export async function listAttachments(client: ApiClient, transactionId: string): Promise<Attachment[]> {
  const data = await client.graphql<{ getTransaction: { attachments: Attachment[] } | null }>("GetTransactionAttachments", LIST, { id: transactionId });
  if (!data.getTransaction) {
    throw new ApiError({ status: 404, statusText: "Not found", operation: "GraphQL GetTransactionAttachments", safeDetail: `no transaction ${transactionId}` });
  }
  return data.getTransaction.attachments ?? [];
}

export async function addAttachment(
  client: ApiClient,
  transactionId: string,
  file: { name: string; type: string; data: Uint8Array },
  upload: UploadOptions = {}
): Promise<Attachment> {
  const info = payload<{ info: { requestParams: UploadTicket } | null }>(
    await client.graphql("Common_GetTransactionAttachmentUploadInfo", TICKET, { transactionId }),
    "getTransactionAttachmentUploadInfo",
    "getTransactionAttachmentUploadInfo"
  );
  if (!info.info?.requestParams) {
    throw new ApiError({ status: 502, statusText: "Unexpected reply", operation: "getTransactionAttachmentUploadInfo", safeDetail: "no upload ticket" });
  }
  const uploaded = await uploadFile(file, info.info.requestParams, upload);
  const added = payload<{ attachment: Attachment | null }>(
    await client.graphql("Common_AddTransactionAttachment", ADD, {
      input: {
        transactionId,
        filename: file.name,
        publicId: uploaded.public_id,
        extension: uploaded.format,
        sizeBytes: uploaded.bytes,
      },
    }),
    "addTransactionAttachment",
    "addTransactionAttachment"
  );
  if (!added.attachment) {
    throw new ApiError({ status: 502, statusText: "Unexpected reply", operation: "addTransactionAttachment", safeDetail: "no attachment in the reply" });
  }
  return added.attachment;
}
