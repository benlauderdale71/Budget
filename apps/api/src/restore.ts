/** Plan a household restore. File household ids are ignored. An id owned by another household rejects the whole file. */

export interface RestorePlan {
  inserts: Record<string, Record<string, unknown>[]>;
  skipped: string[];
  warnings: string[];
}

const COLLECTIONS = ["spaces", "buckets", "accounts", "transactions", "splits", "tags", "assignments", "goals", "schedules"] as const;

export function planRestore(file: unknown, targetHouseholdId: string, owners: Record<string, Record<string, string>>): RestorePlan {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("The backup file is not a BudgetCents backup.");
  const body = file as Record<string, unknown>;
  const version = Number(body.version);
  if (version !== 1 && version !== 2) throw new Error("This backup version is not supported. Export a new backup from this version of BudgetCents.");
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const name of COLLECTIONS) {
    const rows = body[name];
    inserts[name] = [];
    if (rows == null) continue;
    if (!Array.isArray(rows)) throw new Error(`${name} must be a list.`);
    const owned = owners[name] ?? {};
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`A ${name} row is not an object.`);
      const record = { ...(row as Record<string, unknown>) };
      const rowId = name === "tags" ? `${record.transaction_id}:${record.tag}` : String(record.id ?? "");
      if (!rowId || rowId === "undefined:undefined") throw new Error(`A ${name} row is missing an id.`);
      const owner = owned[rowId];
      if (owner && owner !== targetHouseholdId) throw new Error(`Backup id ${rowId} belongs to a different household and was not restored.`);
      if (owner === targetHouseholdId) {
        skipped.push(`${name}:${rowId}`);
        continue;
      }
      if ("household_id" in record) record.household_id = targetHouseholdId;
      inserts[name].push(record);
    }
  }
  if (!inserts.spaces.length && !inserts.accounts.length && !inserts.transactions.length) {
    warnings.push(skipped.length ? "Every row in the file is already in this household." : "The file has no accounts or transactions to add.");
  }
  return { inserts, skipped, warnings };
}
