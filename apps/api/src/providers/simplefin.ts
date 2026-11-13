import { z } from "zod";
import { minorFactor, multiplyDecimalByMinor } from "@budgetcents/domain";
import { ApiError } from "../finance.js";

const hosts = new Set(["bridge.simplefin.org", "beta-bridge.simplefin.org"]);
export function simplefinUrl(value: string, claiming = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "Invalid SimpleFIN token."); }
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.hash || url.search ||
      (claiming ? !/^\/simplefin\/claim\/[^/]+$/.test(url.pathname) || !!url.username || !!url.password : url.pathname !== "/simplefin" || !url.username || !url.password)) {
    throw new ApiError(400, "Use a SimpleFIN Bridge setup token. Other servers are not enabled.");
  }
  return url;
}

export async function claimSimplefin(setupToken: string, request: typeof fetch = fetch): Promise<string> {
  const decoded = Buffer.from(setupToken, "base64").toString("utf8");
  const url = simplefinUrl(decoded, true);
  const response = await request(url, { method: "POST", body: "", redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new ApiError(502, response.status === 403 ? "The SimpleFIN setup token is expired or already claimed. Generate a new one." : "SimpleFIN could not connect. Try again later.");
  const access = (await response.text()).trim();
  simplefinUrl(access);
  return access;
}

const transactionSchema = z.object({ id: z.string(), posted: z.number(), amount: z.string(), description: z.string(), pending: z.boolean().optional(), transacted_at: z.number().optional() });
const accountSchema = z.object({ id: z.string(), name: z.string(), currency: z.string(), balance: z.string(), "balance-date": z.number(), conn_id: z.string().optional(), transactions: z.array(transactionSchema).default([]) });
const accountSetSchema = z.object({ accounts: z.array(accountSchema), errors: z.array(z.string()).optional(), errlist: z.array(z.object({ message: z.string().optional(), code: z.string().optional() }).passthrough()).optional() });
export type SimplefinAccount = z.infer<typeof accountSchema>;

export async function fetchSimplefin(access: string, from: number, to: number, request: typeof fetch = fetch) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 90 * 86400) throw new ApiError(400, "Choose a bank-history window of up to 90 days.");
  const url = simplefinUrl(access);
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
  url.username = ""; url.password = "";
  url.pathname += "/accounts";
  url.search = new URLSearchParams({ version: "2", "start-date": String(from), "end-date": String(to), pending: "0" }).toString();
  const response = await request(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new ApiError(502, response.status === 403 ? "SimpleFIN access was revoked. Reconnect with a new setup token." : response.status === 402 ? "SimpleFIN requires an active subscription." : "SimpleFIN could not refresh. Your saved ledger is unchanged.");
  const result = accountSetSchema.safeParse(await response.json());
  if (!result.success) throw new ApiError(502, "SimpleFIN returned an unsupported response. Nothing was imported.");
  return { ...result.data, warnings: [...(result.data.errors ?? []), ...(result.data.errlist ?? []).map((e) => e.message ?? e.code ?? "A bank reported a connection error.")] };
}

export function simplefinTransactions(account: SimplefinAccount) {
  if (!/^[A-Z]{3}$/.test(account.currency)) throw new ApiError(400, "Custom bank currencies are not supported. Nothing was imported.");
  return account.transactions.filter((t) => !t.pending).map((t) => {
    if (!Number.isFinite(t.posted) || t.posted <= 0) throw new ApiError(502, "A bank transaction has no posted date. Nothing was imported.");
    return { externalId: t.id, date: new Date(t.posted * 1000).toISOString().slice(0, 10), amountMinor: multiplyDecimalByMinor(t.amount, minorFactor(account.currency)), payee: t.description };
  });
}
