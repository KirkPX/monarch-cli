import type { ApiClient } from "../client.js";

export type Holding = {
  id: string;
  quantity: number | null;
  basis: number | null;
  totalValue: number | null;
  securityPriceChangeDollars: number | null;
  securityPriceChangePercent: number | null;
  lastSyncedAt: string | null;
  holdings: { id: string; type: string | null; typeDisplay: string | null; name: string | null; ticker: string | null; closingPrice: number | null; isManual: boolean; closingPriceUpdatedAt: string | null }[];
  security: { id: string; name: string | null; type: string | null; ticker: string | null; typeDisplay: string | null; currentPrice: number | null; currentPriceUpdatedAt: string | null; closingPrice: number | null; closingPriceUpdatedAt: string | null; oneDayChangePercent: number | null; oneDayChangeDollars: number | null } | null;
};

const HOLDINGS = `query Web_GetHoldings($input: PortfolioInput) { portfolio(input: $input) { aggregateHoldings { edges { node {
  id quantity basis totalValue securityPriceChangeDollars securityPriceChangePercent lastSyncedAt
  holdings { id type typeDisplay name ticker closingPrice isManual closingPriceUpdatedAt }
  security { id name type ticker typeDisplay currentPrice currentPriceUpdatedAt closingPrice closingPriceUpdatedAt oneDayChangePercent oneDayChangeDollars }
} } } } }`;

/** Holdings in the given accounts, valued as of `date`. */
export async function getHoldings(client: ApiClient, accountIds: string[], date: string): Promise<Holding[]> {
  const data = await client.graphql<{ portfolio: { aggregateHoldings: { edges: { node: Holding }[] } } }>(
    "Web_GetHoldings",
    HOLDINGS,
    { input: { accountIds, startDate: date, endDate: date, includeHiddenHoldings: true } }
  );
  return (data.portfolio?.aggregateHoldings?.edges ?? []).map((e) => e.node);
}
