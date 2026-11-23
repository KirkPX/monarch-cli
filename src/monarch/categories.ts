import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { payload } from "./payload.js";

export type Category = {
  id: string;
  name: string;
  icon?: string | null;
  isSystemCategory?: boolean;
  excludeFromBudget?: boolean;
  group: { id: string; name: string; type: string } | null;
};

const CATEGORIES = `query GetCategories { categories { id name icon isSystemCategory excludeFromBudget group { id name type } } }`;

export async function listCategories(client: ApiClient): Promise<Category[]> {
  return (await client.graphql<{ categories: Category[] }>("GetCategories", CATEGORIES)).categories;
}

/** A category given by id or by name (any case). A name that matches two categories is refused. */
export function resolveCategory(categories: Category[], value: string): Category {
  const byId = categories.find((c) => c.id === value);
  if (byId) return byId;
  const matches = categories.filter((c) => c.name.toLowerCase() === value.trim().toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new UsageError(
      `"${value}" matches ${matches.length} categories.`,
      `Give the id instead: ${matches.map((c) => `${c.id} (${c.group?.name ?? "no group"})`).join(", ")}.`
    );
  }
  throw new UsageError(`There is no category called "${value}".`, "`monarch categories list` shows them all.");
}

// ── Groups, and adding or removing categories ───────────────────────────────

export type CategoryGroup = { id: string; name: string; order: number; type: string; updatedAt: string | null; createdAt: string | null };

const GROUPS = `query ManageGetCategoryGroups { categoryGroups { id name order type updatedAt createdAt } }`;

export async function listCategoryGroups(client: ApiClient): Promise<CategoryGroup[]> {
  return (await client.graphql<{ categoryGroups: CategoryGroup[] }>("ManageGetCategoryGroups", GROUPS)).categoryGroups;
}

/** A group given by id or by name (any case). */
export function resolveGroup(groups: CategoryGroup[], value: string): CategoryGroup {
  const byId = groups.find((g) => g.id === value);
  if (byId) return byId;
  const matches = groups.filter((g) => g.name.toLowerCase() === value.trim().toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new UsageError(`"${value}" matches ${matches.length} category groups.`, `Give the id instead: ${matches.map((g) => g.id).join(", ")}.`);
  }
  throw new UsageError(`There is no category group called "${value}".`, "`monarch categories groups` shows them all.");
}

const CREATE = `mutation Web_CreateCategory($input: CreateCategoryInput!) {
  createCategory(input: $input) {
    errors { message code fieldErrors { field messages } }
    category { id name icon group { id name type } } } }`;

const DELETE = `mutation Web_DeleteCategory($id: UUID!, $moveToCategoryId: UUID) {
  deleteCategory(id: $id, moveToCategoryId: $moveToCategoryId) {
    errors { message code fieldErrors { field messages } } deleted } }`;

export async function createCategory(
  client: ApiClient,
  input: { groupId: string; name: string; icon?: string }
): Promise<Category> {
  const result = payload<{ category: Category | null }>(
    await client.graphql("Web_CreateCategory", CREATE, {
      input: {
        group: input.groupId,
        name: input.name,
        icon: input.icon ?? "❓",
        rolloverEnabled: false,
        rolloverType: "monthly",
      },
    }),
    "createCategory",
    "createCategory"
  );
  if (!result.category) throw new UsageError("Monarch created no category and gave no reason.");
  return result.category;
}

export async function deleteCategory(client: ApiClient, id: string, moveToCategoryId?: string): Promise<boolean> {
  const result = payload<{ deleted: boolean }>(
    await client.graphql("Web_DeleteCategory", DELETE, { id, moveToCategoryId: moveToCategoryId ?? null }),
    "deleteCategory",
    "deleteCategory"
  );
  return Boolean(result.deleted);
}
