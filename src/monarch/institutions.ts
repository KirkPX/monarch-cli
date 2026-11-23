import type { ApiClient } from "../client.js";

/** One bank connection ("credential") and the institution behind it. */
export type Credential = {
  id: string;
  updateRequired: boolean;
  disconnectedFromDataProviderAt: string | null;
  displayLastUpdatedAt: string | null;
  dataProvider: string | null;
  institution: {
    id: string;
    name: string;
    url: string | null;
    hasIssuesReported: boolean | null;
    hasIssuesReportedMessage: string | null;
    status: string | null;
    balanceStatus: string | null;
    transactionsStatus: string | null;
  } | null;
};

export type InstitutionSettings = {
  credentials: Credential[];
  accounts: { id: string; displayName: string; mask: string | null; deletedAt: string | null; subtype: { display: string } | null; credential: { id: string } | null }[];
};

const SETTINGS = `query Web_GetInstitutionSettings {
  credentials { id updateRequired disconnectedFromDataProviderAt displayLastUpdatedAt dataProvider
    institution { id name url hasIssuesReported hasIssuesReportedMessage status balanceStatus transactionsStatus } }
  accounts(filters: { includeDeleted: true }) { id displayName mask deletedAt subtype { display } credential { id } } }`;

export async function institutionSettings(client: ApiClient): Promise<InstitutionSettings> {
  return await client.graphql<InstitutionSettings>("Web_GetInstitutionSettings", SETTINGS);
}
