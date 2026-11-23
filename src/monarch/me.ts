import type { ApiClient } from "../client.js";

export type Me = { id: string; email: string | null; name: string | null; timezone: string | null };

const ME = `query Common_GetMe { me { id email name timezone } }`;

/** Who the token belongs to. Also the cheapest proof that a token works. */
export async function getMe(client: ApiClient): Promise<Me> {
  const data = await client.graphql<{ me: Me }>("Common_GetMe", ME);
  return data.me;
}
