// `monarch holdings list`: what each investment account holds, valued today.

import { UsageError } from "../../errors.js";
import { listAccounts } from "../../monarch/accounts.js";
import { getHoldings } from "../../monarch/holdings.js";
import { createClient } from "../client-helpers.js";
import { reporter } from "../output.js";
import { isoDate } from "./accounts.js";

export async function holdingsCommand(opts: { json?: boolean; baseUrl?: string; account?: string[] } = {}): Promise<void> {
  const r = reporter(opts);
  const client = createClient({ json: opts.json, baseUrl: opts.baseUrl });
  const accounts = await listAccounts(client);
  const chosen = opts.account?.length
    ? opts.account.map((id) => {
        const a = accounts.find((x) => x.id === id);
        if (!a) throw new UsageError(`There is no account ${id}.`, "`monarch accounts list` shows the ids.");
        return a;
      })
    : accounts.filter((a) => a.type?.name === "brokerage");
  const today = isoDate(new Date());
  const out = [];
  for (const a of chosen) {
    out.push({ account: { id: a.id, name: a.displayName }, holdings: await getHoldings(client, [a.id], today) });
  }
  r.result(
    out,
    out.length === 0
      ? "No investment accounts."
      : out
          .map((x) =>
            [
              `${x.account.name}  (${x.holdings.length} holdings)`,
              ...x.holdings.map(
                (h) =>
                  `    ${(h.security?.ticker ?? h.holdings[0]?.ticker ?? "").padEnd(8)} ${(h.security?.name ?? h.holdings[0]?.name ?? "").padEnd(36).slice(0, 36)} ${String(h.quantity ?? "").padStart(12)}  ${(h.totalValue ?? 0).toFixed(2).padStart(14)}`
              ),
            ].join("\n")
          )
          .join("\n")
  );
}
