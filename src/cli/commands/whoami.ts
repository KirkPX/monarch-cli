// `monarch whoami` shows which Monarch user the saved token belongs to.

import { createClient } from "../client-helpers.js";
import { reporter } from "../output.js";
import { getMe } from "../../monarch/me.js";

export async function whoamiCommand(
  opts: { json?: boolean; account?: string; baseUrl?: string } = {}
): Promise<void> {
  const r = reporter(opts);
  const me = await getMe(createClient(opts));
  r.result(me, `${me.name ?? "(no name)"} <${me.email ?? "no email"}>  ${me.id}`);
}
