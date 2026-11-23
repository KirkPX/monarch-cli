// `monarch institutions list`: each bank connection, its status, and its accounts.

import { institutionSettings } from "../../monarch/institutions.js";
import { createClient } from "../client-helpers.js";
import { reporter } from "../output.js";

export async function institutionsCommand(opts: { json?: boolean; baseUrl?: string } = {}): Promise<void> {
  const r = reporter(opts);
  const s = await institutionSettings(createClient(opts));
  const rows = s.credentials.map((c) => ({
    ...c,
    accounts: s.accounts.filter((a) => a.credential?.id === c.id && !a.deletedAt).map((a) => ({ id: a.id, name: a.displayName, mask: a.mask })),
  }));
  r.result(
    rows,
    rows.length === 0
      ? "No bank connections."
      : rows
          .map((c) => {
            const state = c.updateRequired ? "needs bank sign-in" : c.disconnectedFromDataProviderAt ? "disconnected" : "connected";
            const status = c.institution?.status && c.institution.status !== "HEALTHY" ? `, bank status ${c.institution.status}` : "";
            return [
              `${c.institution?.name ?? "(unknown bank)"}: ${state}${status}, last updated ${c.displayLastUpdatedAt?.slice(0, 10) ?? "never"}`,
              ...c.accounts.map((a) => `    ${a.name}${a.mask ? ` (...${a.mask})` : ""}  ${a.id}`),
            ].join("\n");
          })
          .join("\n")
  );
}
