import { duplicateKey, groupImportRows, type ImportGroup, type ImportRow } from "@budgetcents/domain";

export interface StoredImportResult {
  created: number;
  skipped: number;
  transactionIds: string[];
  createdCategories: { id: string; name: string }[];
}

export interface StoredImport {
  version: 2;
  rows: ImportRow[];
  groups: ImportGroup[];
  fingerprint?: string;
  result?: StoredImportResult;
  commit?: { accountId: string; rowNumbers: number[]; categoryMap: Record<string, string>; createMissingCategories: boolean; transferChoices?: Record<string, string> };
}

export interface DecoratedGroup extends ImportGroup {
  duplicate: boolean;
  possibleMatch: boolean;
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

export function importFingerprint(accountId: string, rowNumbers: number[], categoryMap: Record<string, string>, createMissing: boolean, transferChoices: Record<string, string> = {}): string {
  const rows = [...rowNumbers].sort((a, b) => a - b).join(",");
  const map = Object.entries(categoryMap)
    .filter(([, value]) => value.trim())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.trim().toLowerCase()}=${value.trim()}`)
    .join("|");
  const choices = Object.entries(transferChoices).sort(([a], [b]) => a.localeCompare(b));
  return `${accountId}#${rows}#${createMissing ? 1 : 0}#${map}${choices.length ? `#${JSON.stringify(choices)}` : ""}`;
}

export function importProviderId(group: ImportGroup, accountId: string): string | undefined {
  return group.fitId && group.csvSource ? `csv:${accountId}:${group.fitId}` : group.fitId;
}

export function decorateGroups(groups: ImportGroup[], existing: { date: string; amountMinor: number; payee: string; fitId?: string }[]): DecoratedGroup[] {
  const providerIds = new Set(existing.map((row) => row.fitId).filter((fitId): fitId is string => !!fitId));
  const keys = new Set(existing.map((row) => duplicateKey({ date: row.date, amountMinor: row.amountMinor, description: row.payee, account: "" })));
  const seen = new Set<string>();
  return groups.map((group) => {
    const duplicate = !!group.fitId && (providerIds.has(group.fitId) || seen.has(group.fitId));
    if (group.fitId) seen.add(group.fitId);
    return {
      ...group,
      duplicate,
      possibleMatch: !duplicate && !!group.duplicateKey && keys.has(group.duplicateKey),
    };
  });
}

export function decorateRows(rows: ImportRow[], groups: DecoratedGroup[]) {
  const byKey = new Map(groups.map((group) => [group.groupKey, group]));
  return rows.map((row) => {
    const group = row.groupKey ? byKey.get(row.groupKey) : undefined;
    return { ...row, duplicate: group?.duplicate ?? false, possibleMatch: group?.possibleMatch ?? false };
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
