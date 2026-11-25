import { groupImportRows, type ImportGroup, type ImportRow } from "@budgetcents/domain";
import { sha256 } from "./crypto.js";
import { num, str, type Database } from "./db.js";
import { canSeeAccount } from "./finance.js";

export interface StoredImportResult {
  created: number;
  skipped: number;
  heldForReview?: number;
  transactionIds: string[];
  createdCategories: { id: string; name: string }[];
}

export interface StoredImport {
  version: 2;
  rows: ImportRow[];
  groups: ImportGroup[];
  fingerprint?: string;
  result?: StoredImportResult;
  commit?: { accountId: string; rowNumbers: number[]; categoryMap: Record<string, string>; createMissingCategories: boolean; transferChoices?: Record<string, string>; keepMatches?: Record<string, string> };
}

export interface DecoratedGroup extends ImportGroup {
  duplicate: boolean;
  possibleMatch: boolean;
  matchReason?: string;
  matchToken?: string;
}

export function readStoredImport(raw: string): StoredImport {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    const rows = (parsed as ImportRow[]).map((row) => ({ ...row, errors: row.errors ?? [], warnings: row.warnings ?? [] }));
    return { version: 2, rows, groups: groupImportRows(rows) };
  }
  const stored = parsed as Partial<StoredImport>;
  const rows = (stored.rows ?? []).map((row) => ({ ...row, errors: row.errors ?? [], warnings: row.warnings ?? [] }));
  return {
    version: 2,
    rows,
    groups: stored.groups?.length ? stored.groups : groupImportRows(rows),
    fingerprint: stored.fingerprint,
    result: stored.result,
    commit: stored.commit,
  };
}

export function importFingerprint(accountId: string, rowNumbers: number[], categoryMap: Record<string, string>, createMissing: boolean, transferChoices: Record<string, string> = {}, keepMatches: Record<string,string> = {}): string {
  const rows = [...rowNumbers].sort((a, b) => a - b).join(",");
  const map = Object.entries(categoryMap)
    .filter(([, value]) => value.trim())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.trim().toLowerCase()}=${value.trim()}`)
    .join("|");
  const choices = Object.entries(transferChoices).sort(([a], [b]) => a.localeCompare(b));
  const kept = Object.entries(keepMatches).sort(([a], [b]) => a.localeCompare(b));
  return `${accountId}#${rows}#${createMissing ? 1 : 0}#${map}${choices.length ? `#${JSON.stringify(choices)}` : ""}${kept.length ? `#keep:${JSON.stringify(kept)}` : ""}`;
}

export function importProviderId(group: ImportGroup, accountId: string): string | undefined {
  if (!group.fitId && group.sourceRowId) return `file:${accountId}:${group.sourceRowId}`;
  return group.fitId && group.csvSource ? `csv:${accountId}:${group.fitId}` : group.fitId;
}

export function sourceGroups(rows: ImportRow[], text: string) {
  const fileHash = sha256(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  const byRow = new Map(rows.map(row => [row.rowNumber, row]));
  return groupImportRows(rows).map(group => {
    const row = byRow.get(group.rowNumbers[0]);
    const documentRow = row?.sourceCells?.find(cell => cell.column === "Statement row ID")?.value;
    const sourceRowId = group.rowNumbers.length === 1 && documentRow && /^[a-f0-9]{64}:[1-9]\d{0,4}$/.test(documentRow)
      ? documentRow : fileHash + ":" + group.rowNumbers[0];
    return { ...group, sourceRowId };
  });
}

interface MatchRow {
  id: string;
  date: string;
  amountMinor: number;
  payee: string;
  originalDescription?: string;
  checkNumber?: string;
  fitId?: string;
  sourceRowId?: string;
  pending: boolean;
  observedBalanceMinor?: number;
}

export async function importLedger(db: Database, householdId: string, spaceId: string, userId: string, accountId?: string): Promise<MatchRow[]> {
  const rows = await db.query(`SELECT t.id, t.date, t.amount_minor, t.payee, t.original_description, t.check_number,
    t.bank_status, t.account_id, t.provider_transaction_id, a.visibility, a.owner_user_id,
    c.visibility AS counter_visibility, c.owner_user_id AS counter_owner
    FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN accounts c ON c.id=t.counter_account_id
    WHERE t.household_id=$1 AND t.deleted=0 AND a.space_id=$2 AND ($3::text IS NULL OR t.account_id=$3) ORDER BY t.id`,
    [householdId, spaceId, accountId ?? null]);
  return rows.filter(row => canSeeAccount(userId, { visibility: String(row.visibility), owner_user_id: str(row.owner_user_id) ?? null })
    && (!row.counter_visibility || canSeeAccount(userId, { visibility: String(row.counter_visibility), owner_user_id: str(row.counter_owner) ?? null })))
    .map(row => {
      const provider = str(row.provider_transaction_id);
      const filePrefix = "file:" + row.account_id + ":";
      const bankPrefix = "csv:" + row.account_id + ":";
      const sourceRowId = provider?.startsWith(filePrefix) ? provider.slice(filePrefix.length) : undefined;
      const fitId = sourceRowId ? undefined : provider?.startsWith(bankPrefix) ? provider.slice(bankPrefix.length) : provider;
      return { id: String(row.id), date: String(row.date), amountMinor: num(row.amount_minor), payee: String(row.payee),
        originalDescription: str(row.original_description), checkNumber: str(row.check_number), pending: row.bank_status === "pending", fitId, sourceRowId };
    });
}

function merchantKey(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/^(?:(?:pos|visa|mastercard|card|debit|credit|purchase|pending)\b[\s:*-]*)+/u, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function similarSpelling(a: string, b: string) {
  if (Math.min(a.length, b.length) < 6 || Math.abs(a.length - b.length) > 1) return false;
  // OCR can repeat the same character confusion. Only use this as a review hint.
  if (a.replace(/0/g, "o").replace(/[1i]/g, "l") === b.replace(/0/g, "o").replace(/[1i]/g, "l")) return true;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + a.length - i + b.length - j <= 1;
}

type Candidate = MatchRow & { names: string[]; day: number; inFile: boolean };

export function decorateGroups(groups: ImportGroup[], ledger: MatchRow[], accountId = ""): DecoratedGroup[] {
  const buckets = new Map<string, Candidate[]>();
  const ids = new Set<string>();
  function candidate(row: MatchRow, inFile: boolean): Candidate {
    const names = [...new Set([row.payee, row.originalDescription || ""].map(merchantKey))].filter(s => s && s !== "imported");
    return { ...row, names, day: Date.parse(row.date) / 86_400_000, inFile };
  }
  function index(row: Candidate) {
    if (row.fitId) ids.add("bank:" + row.fitId);
    if (row.sourceRowId) ids.add("file:" + row.sourceRowId);
    const key = row.amountMinor + "/" + row.day;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  for (const row of ledger) index(candidate(row, false));
  return groups.map(group => {
    const result: DecoratedGroup = { ...group, duplicate: false, possibleMatch: false };
    if (group.errors.length || !group.date || group.amountMinor == null) return result;
    const row = candidate({ ...group, id: group.groupKey, date: group.date, amountMinor: group.amountMinor, pending: group.bankStatus === "pending" }, true);
    if ((row.fitId && ids.has("bank:" + row.fitId)) || (row.sourceRowId && ids.has("file:" + row.sourceRowId))) {
      result.duplicate = true;
      result.matchReason = row.fitId ? "Same bank transaction ID." : "Same row from the same uploaded file.";
      return result;
    }
    // An unscoped legacy preview can identify bank IDs. Similarity requires a specific account.
    if (accountId && row.names.length) {
      const nearby = [0, -1, 1, -2, 2].map(offset => buckets.get(row.amountMinor + "/" + (row.day + offset)) ?? []);
      let match: Candidate | undefined;
      for (const candidates of nearby) {
        match = candidates.find(other => {
          if (row.fitId && other.fitId && row.fitId !== other.fitId) return false;
          if (row.checkNumber && other.checkNumber && row.checkNumber !== other.checkNumber) return false;
          if (row.observedBalanceMinor != null && other.observedBalanceMinor != null && row.observedBalanceMinor !== other.observedBalanceMinor) return false;
          const sameDay = row.day === other.day;
          if (!sameDay && row.pending === other.pending) return false;
          return row.names.some(a => other.names.some(b => a === b || (sameDay && similarSpelling(a, b))));
        });
        if (match) break;
      }
      if (match) {
        result.possibleMatch = true;
        result.matchReason = (match.inFile ? "Another selected file or row" : "This account") + " contains " + match.payee + " on " + match.date + " for the same signed amount.";
        result.matchToken = sha256(JSON.stringify([accountId, group.groupKey, match.inFile, match.id, nearby.map(bucket => bucket.length)]));
      }
    }
    index(row);
    return result;
  });
}

export function decorateRows(rows: ImportRow[], groups: DecoratedGroup[]) {
  const byKey = new Map(groups.map((group) => [group.groupKey, group]));
  return rows.map((row) => {
    const group = row.groupKey ? byKey.get(row.groupKey) : undefined;
    return { ...row, duplicate: group?.duplicate ?? false, possibleMatch: group?.possibleMatch ?? false, matchReason: group?.matchReason, matchToken: group?.matchToken };
  });
}

export function summarizeCategories(groups: ImportGroup[], buckets: { id: string; name: string; kind: string; archived: boolean }[]) {
  const found = new Map<string, { name: string; kinds: Set<string>; count: number }>();
  for (const group of groups) {
    for (const split of group.splits ?? []) {
      const key = split.category.trim().toLowerCase().replace(/\s+/g, " ");
      const current = found.get(key) ?? { name: split.category, kinds: new Set<string>(), count: 0 };
      current.kinds.add(split.role === "income" ? "income" : "expense");
      current.count += 1;
      found.set(key, current);
    }
  }
  return [...found.values()].map((item) => {
    const kind = item.kinds.size === 1 ? [...item.kinds][0] : "expense";
    const matches = buckets.filter((bucket) => !bucket.archived && bucket.kind === kind && bucket.name.trim().toLowerCase().replace(/\s+/g, " ") === item.name.trim().toLowerCase().replace(/\s+/g, " "));
    return {
      name: item.name,
      kind,
      count: item.count,
      conflict: item.kinds.size > 1,
      ambiguous: matches.length > 1,
      match: matches.length === 1 ? { id: matches[0].id, name: matches[0].name, kind: matches[0].kind } : null,
    };
  });
}
