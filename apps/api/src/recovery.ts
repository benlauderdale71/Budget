import { sha256 } from "./crypto.js";
import type { Database } from "./db.js";
import { transactionImportSources } from "./import-batch.js";

type Row = Record<string, unknown>;
export type Collections = Record<string, Row[]>;
export const recoveryTables = {
  transaction_import_sources: ["transaction_id source_row_id", ""],
  statement_periods: [
    "account_id end_date",
    "start_date closing_minor deposits_minor withdrawals_minor transaction_count",
  ],
  account_lifetimes: ["account_id", "opened closed"],
  income_sources: [
    "id",
    "household_id space_id name kind owner_user_id account_id amount_minor amount_max_minor cadence custom_interval anchor_day twice_day_a twice_day_b start_date end_date paused archived notes version created_at updated_at",
  ],
  income_dates: ["source_id expected_date", "amount_minor amount_max_minor note"],
  income_exceptions: ["source_id exception_date", ""],
  income_occurrences: [
    "id",
    "household_id source_id occurrence_key expected_date status expected_amount_minor revised_date revised_amount_minor received_date received_amount_minor remaining_minor delayed_until transaction_id extra_transaction_id note client_op_id settle_op_id scope created_at updated_at",
  ],
  catch_up_plans: ["account_id user_id", "terms_json version"],
  merchant_corrections: [
    "id",
    "account_id creator_id merchant_key bucket_id future undone created_at preview_token",
  ],
  merchant_correction_rows: [
    "batch_id transaction_id",
    "split_id prior_bucket inserted_split removed_estimate applied_version",
  ],
  physical_asset_documents: [
    "id",
    "household_id owner_user_id filename data_base64 fingerprint size_bytes created_at",
  ],
  physical_assets: [
    "id",
    "household_id owner_user_id payload_json version source_key document_id created_at updated_at",
  ],
  physical_asset_files: ["asset_id document_id", ""],
  physical_asset_estimates: ["id", "asset_id user_id payload_json created_at"],
};
export const coreTables = [
  "spaces",
  "accounts",
  "buckets",
  "transactions",
  "splits",
  "tags",
  "assignments",
  "goals",
  "schedules",
];
const ids = (rows: Row[]) => rows.map((r) => String(r.id));
const refs: Record<string, string> = {
  source_id: "income_sources",
  extra_transaction_id: "transactions",
  space_id: "spaces",
  business_space_id: "spaces",
  account_id: "accounts",
  counter_account_id: "accounts",
  linked_account_id: "accounts",
  transaction_id: "transactions",
  refund_of_id: "transactions",
  bucket_id: "buckets",
  prior_bucket: "buckets",
  schedule_id: "schedules",
  batch_id: "merchant_corrections",
  asset_id: "physical_assets",
  document_id: "physical_asset_documents",
};
export async function recoveryData(
  db: Database,
  hid: string,
  user: string,
  core: Collections,
): Promise<Collections> {
  const by = (table: string, column: string, values: string[]) =>
    db.query("SELECT * FROM " + table + " WHERE " + column + "=ANY($1::text[])", [values]);
  const accounts = ids(core.accounts),
    txns = new Set(ids(core.transactions)),
    buckets = new Set(ids(core.buckets));
  const spaceIds = new Set(ids(core.spaces));
  const sources = (await by("income_sources", "account_id", accounts)).filter((r) =>
    spaceIds.has(String(r.space_id)),
  );
  const corrections = (await by("merchant_corrections", "account_id", accounts)).filter(
    (r) => r.creator_id === user && buckets.has(String(r.bucket_id)),
  );
  const assets = (await db.query("SELECT * FROM physical_assets WHERE household_id=$1", [hid])).filter(
    (r) => r.owner_user_id === user || JSON.parse(String(r.payload_json)).visibility === "shared",
  );
  const files = await by("physical_asset_files", "asset_id", ids(assets));
  const linkedDocs = [
    ...new Set([...assets, ...files].flatMap((r) => (r.document_id ? [String(r.document_id)] : []))),
  ];
  const docs = await db.query(
    "SELECT * FROM physical_asset_documents WHERE household_id=$1 AND owner_user_id=$2 AND id=ANY($3::text[])",
    [hid, user, linkedDocs],
  );
  const docIds = new Set(ids(docs));
  return {
    transaction_import_sources: await transactionImportSources(db, [...txns]),
    statement_periods: await by("statement_periods", "account_id", accounts),
    account_lifetimes: await by("account_lifetimes", "account_id", accounts),
    income_sources: sources,
    income_dates: await by("income_dates", "source_id", ids(sources)),
    income_exceptions: await by("income_exceptions", "source_id", ids(sources)),
    income_occurrences: await by("income_occurrences", "source_id", ids(sources)),
    catch_up_plans: await db.query(
      "SELECT * FROM catch_up_plans WHERE user_id=$1 AND account_id=ANY($2::text[])",
      [user, accounts],
    ),
    merchant_corrections: corrections,
    merchant_correction_rows: (await by("merchant_correction_rows", "batch_id", ids(corrections))).filter(
      (r) => txns.has(String(r.transaction_id)),
    ),
    physical_asset_documents: docs,
    physical_assets: assets.map((r) => ({
      ...r,
      document_id: docIds.has(String(r.document_id)) ? r.document_id : null,
    })),
    physical_asset_files: files.filter((r) => docIds.has(String(r.document_id))),
    physical_asset_estimates: await by("physical_asset_estimates", "asset_id", ids(assets)),
  };
}
export function prepareRecovery(
  file: Row,
  target: string,
  user: string,
  visible: Collections,
  owners: Record<string, Record<string, string>>,
) {
  const source = String(file.householdId ?? "");
  if (!source) throw Error("Missing backup household.");
  const copy = source !== target;
  const tables = [...coreTables, ...Object.keys(recoveryTables)];
  const rows: Collections = {},
    keys: Record<string, Set<string>> = {};
  for (const table of tables) {
    const list = file[table] ?? [];
    if (!Array.isArray(list) || list.some((r) => !r || typeof r !== "object" || Array.isArray(r)))
      throw Error("Invalid backup collection " + table);
    rows[table] = list.map((r) => ({ ...r }));
    keys[table] = new Set(ids(rows[table]));
  }
  const existingDocuments = new Map((visible.physical_asset_documents ?? [])
    .filter(row => row.owner_user_id === user).map(row => [row.fingerprint, row.id]));
  const reusedDocuments = new Map(rows.physical_asset_documents
    .filter(row => existingDocuments.has(row.fingerprint))
    .map(row => [row.id, existingDocuments.get(row.fingerprint)]));
  const mapId = (table: string, value: unknown) =>
    copy && table === "physical_asset_documents" && reusedDocuments.has(value) ? reusedDocuments.get(value) :
    copy ? "restored-" + sha256(JSON.stringify([source, target, table, value])).slice(0, 40) : value;
  if (copy) {
    // Each imported row keeps its own identity and attachments. Only one row can
    // claim an inventory import key when several original owners become one.
    const used = new Map((visible.physical_assets ?? []).filter(row => row.owner_user_id === user && row.source_key != null)
      .map(row => [row.source_key, row.id]));
    for (const asset of [...rows.physical_assets].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      if (asset.source_key == null) continue;
      const id = mapId("physical_assets", asset.id);
      if (used.has(asset.source_key) && used.get(asset.source_key) !== id) asset.source_key = null;
      else used.set(asset.source_key, id);
    }
  }
  const splitParents = new Map(rows.splits.map((s) => [s.id, s.transaction_id]));
  for (const table of tables) {
    const visibleIds = new Set(ids(visible[table] ?? []));
    for (const r of rows[table]) {
      const oldAccount = r.account_id,
        oldTransaction = r.transaction_id;
      if (r.id != null) {
        if (typeof r.id !== "string" || !r.id) throw Error("Invalid row identifier in " + table);
        if (!copy && owners[table]?.[r.id] === target && !visibleIds.has(r.id))
          throw Error("A row is outside your visible records.");
        r.id = mapId(table, r.id);
      }
      if ("household_id" in r) r.household_id = target;
      for (const [field, parent] of Object.entries(refs)) {
        if (r[field] == null) continue;
        if (!keys[parent].has(String(r[field])))
          throw Error("Missing " + parent + " reference in " + table + ".");
        r[field] = mapId(parent, r[field]);
      }
      if (table === "merchant_correction_rows") {
        if (!r.split_id) throw Error("Missing correction split.");
        if (splitParents.has(r.split_id) && splitParents.get(r.split_id) !== oldTransaction)
          throw Error("Correction split belongs to another transaction.");
        r.split_id = mapId("splits", r.split_id);
      }
      if (table === "transactions" && copy && typeof r.provider_transaction_id === "string") {
        const prefix = "csv:" + String(oldAccount) + ":";
        if (r.provider_transaction_id.startsWith(prefix))
          r.provider_transaction_id = "csv:" + r.account_id + ":" + r.provider_transaction_id.slice(prefix.length);
      }
      if (table === "transaction_import_sources" && (typeof r.source_row_id !== "string" || !/^[a-f0-9]{64}:[1-9]\d{0,6}$/.test(r.source_row_id)))
        throw Error("Invalid transaction import source row.");
      if (copy) {
        if (table === "income_occurrences") r.occurrence_key = r.source_id + ":" + r.expected_date;
        for (const field of [
          "owner_user_id",
          "creator_id",
          "user_id",
          "reviewer_user_id",
          "review_assigned_by",
          "review_resolved_by",
        ]) {
          if (r[field] != null) r[field] = user;
        }
      }
      if (table === "catch_up_plans" && r.user_id !== user) throw Error("Catch-up plans are personal.");
      if (table === "merchant_corrections" && r.creator_id !== user)
        throw Error("Merchant correction history belongs to its creator.");
      if (table === "physical_asset_documents") {
        const data = String(r.data_base64);
        if (
          data.length > 10_666_668 ||
          sha256(data) !== r.fingerprint ||
          Buffer.from(data, "base64").length !== Number(r.size_bytes)
        )
          throw Error("An asset file failed its integrity check.");
        if (r.owner_user_id !== user) throw Error("Asset documents are personal.");
      }
      if (table === "physical_assets" || table === "physical_asset_estimates" || table === "catch_up_plans") {
        JSON.parse(String(r.payload_json ?? r.terms_json));
      }
    }
  }
  const extra: Collections = {};
  let skipped = 0;
  for (const [name, [pk]] of Object.entries(recoveryTables)) {
    const fields = pk.split(" ");
    const key = (r: Row) => JSON.stringify(fields.map((k) => r[k]));
    const existing = new Set((visible[name] ?? []).map(key)),
      seen = new Set<string>();
    extra[name] = rows[name].filter((r) => {
      if (fields.some((k) => r[k] == null || r[k] === "") || seen.has(key(r)))
        throw Error("Invalid or repeated key in " + name);
      seen.add(key(r));
      if (existing.has(key(r))) {
        skipped++;
        return false;
      }
      return true;
    });
  }
  return { core: { ...rows, version: 2 }, extra, skipped, copy };
}

/** Remove optional links to records omitted from a scoped export, including deleted refunds and schedules. */
export function scopeLinks(rows: Collections) {
  const present = Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, new Set(ids(list))]));
  for (const list of Object.values(rows))
    for (const row of list)
      for (const [field, table] of Object.entries(refs)) {
        if (row[field] != null && !present[table]?.has(String(row[field]))) row[field] = null;
      }
  return rows;
}
