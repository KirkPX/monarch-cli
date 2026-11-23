import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { payload } from "./payload.js";

export type Tag = { id: string; name: string; color: string | null; order: number | null; transactionCount?: number };

const TAGS = `query GetHouseholdTransactionTags { householdTransactionTags { id name color order transactionCount } }`;

export async function listTags(client: ApiClient): Promise<Tag[]> {
  return (await client.graphql<{ householdTransactionTags: Tag[] }>("GetHouseholdTransactionTags", TAGS)).householdTransactionTags;
}

/** Tag names (any case) or ids to tags. Every one must already exist in Monarch. */
export function resolveTags(tags: Tag[], values: string[]): Tag[] {
  const missing: string[] = [];
  const found = values.map((v) => {
    const t = tags.find((x) => x.id === v) ?? tags.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
    if (!t) missing.push(v);
    return t;
  });
  if (missing.length) {
    throw new UsageError(
      `No tag called ${missing.map((m) => `"${m}"`).join(", ")} in Monarch.`,
      "Create it first with `monarch tags create <name>`, or check `monarch tags list`."
    );
  }
  return found as Tag[];
}

/** "b; a" -> ["a", "b"]: the form tags are compared in. */
export function splitTagList(value: string): string[] {
  return value.split(";").map((x) => x.trim()).filter(Boolean);
}

// ── Adding and removing tags ────────────────────────────────────────────────

const CREATE = `mutation Common_CreateTransactionTag($input: CreateTransactionTagInput!) {
  createTransactionTag(input: $input) { tag { id name color order transactionCount } errors { message code fieldErrors { field messages } } } }`;

// Not in the community library; found by asking Monarch with an id that matches no
// tag. The reply has only `errors`, so success is checked by reading the tags back.
const DELETE = `mutation Common_DeleteTransactionTag($tagId: ID!) {
  deleteTransactionTag(tagId: $tagId) { errors { message code fieldErrors { field messages } } } }`;

export async function createTag(client: ApiClient, name: string, color: string): Promise<Tag> {
  const result = payload<{ tag: Tag | null }>(
    await client.graphql("Common_CreateTransactionTag", CREATE, { input: { name, color } }),
    "createTransactionTag",
    "createTransactionTag"
  );
  if (!result.tag) throw new UsageError("Monarch created no tag and gave no reason.");
  return result.tag;
}

export async function deleteTag(client: ApiClient, id: string): Promise<void> {
  payload(await client.graphql("Common_DeleteTransactionTag", DELETE, { tagId: id }), "deleteTransactionTag", "deleteTransactionTag");
}
