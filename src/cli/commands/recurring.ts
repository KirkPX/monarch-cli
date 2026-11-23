// `monarch recurring …`: the bills and income Monarch sees repeating.

import { UsageError } from "../../errors.js";
import { recurringItems, recurringStreams } from "../../monarch/recurring.js";
import { createClient } from "../client-helpers.js";
import { reporter } from "../output.js";

type Opts = { json?: boolean; baseUrl?: string; start?: string; end?: string };

export async function listCommand(opts: Opts): Promise<void> {
  const r = reporter(opts);
  if (Boolean(opts.start) !== Boolean(opts.end)) throw new UsageError("Give both --start and --end, or neither.");
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const startDate = opts.start ?? `${now.getFullYear()}-${p(now.getMonth() + 1)}-01`;
  const endDate = opts.end ?? `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(last)}`;
  const items = await recurringItems(createClient(opts), startDate, endDate);
  items.sort((a, b) => a.date.localeCompare(b.date));
  r.result(
    { startDate, endDate, items },
    items.length
      ? items
          .map(
            (i) =>
              `${i.date}  ${(i.amount ?? i.stream.amount ?? 0).toFixed(2).padStart(10)}  ${(i.stream.merchant?.name ?? "").padEnd(28).slice(0, 28)}  ${i.stream.frequency.padEnd(14)} ${i.isPast ? (i.transactionId ? "paid" : "missed?") : "due"}`
          )
          .join("\n")
      : `No recurring items from ${startDate} to ${endDate}.`
  );
}

export async function streamsCommand(opts: Opts & { noLiabilities?: boolean; liabilities?: boolean }): Promise<void> {
  const r = reporter(opts);
  const streams = await recurringStreams(createClient(opts), opts.liabilities !== false);
  streams.sort((a, b) => (a.stream.merchant?.name ?? a.stream.name ?? "").localeCompare(b.stream.merchant?.name ?? b.stream.name ?? ""));
  r.result(
    streams,
    streams.length
      ? streams
          .map(
            (s) =>
              `${(s.stream.merchant?.name ?? s.stream.name ?? "").padEnd(30).slice(0, 30)} ${(s.stream.amount ?? 0).toFixed(2).padStart(10)} ${s.stream.frequency.padEnd(14)} next ${s.nextForecastedTransaction?.date ?? "-"}${s.stream.isActive ? "" : "  (inactive)"}`
          )
          .join("\n")
      : "No recurring streams."
  );
}
