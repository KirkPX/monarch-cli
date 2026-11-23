// `monarch attachments …`: list the files on a transaction, and attach a receipt.
// An added file is read back from the transaction before it is reported.

import { UsageError } from "../../errors.js";
import { addAttachment, listAttachments, readAttachmentFile } from "../../monarch/attachments.js";
import { createClient } from "../client-helpers.js";
import { assertWritable, printDryRun, type GuardOptions } from "../guardrails.js";
import { reporter } from "../output.js";

type Common = { json?: boolean; baseUrl?: string } & GuardOptions;

export async function listCommand(id: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  const files = await listAttachments(createClient(opts), id);
  r.result(files, files.length ? files.map((f) => `${f.filename}  ${f.sizeBytes} bytes  ${f.id}`).join("\n") : "No attachments.");
}

export async function addCommand(id: string, path: string, opts: Common): Promise<void> {
  const r = reporter(opts);
  assertWritable(opts);
  const file = await readAttachmentFile(path);
  const client = createClient(opts);
  const before = await listAttachments(client, id); // also proves the transaction exists
  if (opts.dryRun) {
    printDryRun({ changed: true, summary: `Would attach ${file.name} (${file.data.length} bytes) to ${id}` }, true, r, { existing: before.length });
    return;
  }
  // The upload goes only to Monarch's image host (src/client-upload.ts), with no Monarch token.
  const added = await addAttachment(client, id, file);
  const after = await listAttachments(client, id);
  if (!after.some((a) => a.id === added.id)) throw new UsageError(`Monarch said it attached ${file.name}, but it does not read back on ${id}.`);
  printDryRun({ changed: true, summary: `Attached ${file.name} to ${id} (checked)` }, false, r, { attachment: added });
}
