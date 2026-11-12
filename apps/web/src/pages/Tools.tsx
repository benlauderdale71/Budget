import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BankConnection } from "./BankConnection.js";
import { LiveMessageTests } from "./LiveMessageTests.js";
import { api, clearLocalSession, downloadFile } from "../api.js";
import { formatMoney, parseAmount } from "../format.js";
import { scoped, useAccess, useSession } from "../session.js";
import type { Dashboard, Txn } from "../types.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useFormError, useLoad } from "../ui.js";

const moreLinks = [
  ["/forecast", "Forecast", "Cash projection and paycheck coverage"],
  ["/receipts", "Receipts", "Read a receipt, then confirm it"],
  ["/paychecks", "Paychecks", "Expected income that is not cash yet"],
  ["/calendar", "Calendar", "Paychecks, bills, and due dates"],
  ["/bills", "Bills", "Recurring bills and subscriptions"],
  ["/debts", "Debts", "Saved extra-payment and refinance plans"],
  ["/goals", "Goals", "Envelopes with a target"],
  ["/alerts", "Alerts", "Bills, balances, and goals you choose to watch"],
  ["/reports", "Reports", "Spending, savings rate, exports"],
  ["/investments", "Investments", "Holdings and manual prices"],
  ["/retirement", "Retirement", "A seeded model, not a promise"],
  ["/assistant", "Assistant", "Answers from ledger facts"],
  ["/household", "Sharing", "People, roles, and spaces"],
  ["/rules", "Rules", "Payee rules that do not override a lock"],
  ["/import", "Import", "Preview a file, then confirm"],
  ["/providers", "Connections", "What is live and what is not"],
  ["/cases", "Requests", "Cancellation notes, with no biller contacted"],
  ["/credit", "Credit", "A score you type, not a bureau report"],
  ["/learn", "Learn", "Short original lessons"],
  ["/help", "Help", "Search guidance written for BudgetCents"],
  ["/checklists", "Checklists", "Tax and estate lists, not legal documents"],
  ["/setup", "Setup", "Resume or review household setup"],
  ["/settings", "Settings", "Security, export, and deletion"],
];

export function More() {
  return (
    <Page title="More" lede="The same household is behind every tool.">
      <div className="more-grid">
        {moreLinks.map(([to, title, body]) => <Link key={to} to={to} className="card"><h2>{title}</h2><p className="muted">{body}</p></Link>)}
      </div>
    </Page>
  );
}

export function Assistant() {
  const session = useSession();
  const [answer, setAnswer] = useState<{ text: string; facts: { label: string; formula?: string }[]; missing: string[] } | null>(null);
  const form = useFormError();
  const dash = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  return (
    <Page title="Assistant" lede="Questions are answered from figures BudgetCents already calculated. Text you paste is data, not an instruction to move money.">
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        setAnswer(await api(scoped(session.householdId, "/assistant"), { method: "POST", body: JSON.stringify({ question: data.get("question"), spaceId: session.spaceId }) }));
      })}>
        <Field label="Question"><textarea name="question" required placeholder="What can I safely spend?" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Ask</button>
      </form>
      {answer ? <article className="card" style={{ marginTop: 16 }}><p>{answer.text}</p>{answer.facts.map((fact) => <p key={fact.label} className="formula">{fact.label}{fact.formula ? ` — ${fact.formula}` : ""}</p>)}{answer.missing.length ? <p>Missing: {answer.missing.join(", ")}</p> : null}</article> : null}
      <AssistantActions dash={dash.data} />
    </Page>
  );
}

const ASSISTANT_KINDS = [
  ["create_transaction", "Transaction"],
  ["create_category", "Category"],
  ["set_category", "Categorize"],
  ["set_tags", "Tags"],
  ["create_rule", "Rule"],
  ["create_goal", "Goal"],
  ["adjust_plan", "Plan"],
] as const;

type AssistantKind = (typeof ASSISTANT_KINDS)[number][0];

function AssistantActions({ dash }: { dash?: Dashboard }) {
  const session = useSession();
  const action = useFormError();
  const txns = useLoad(() => api<{ transactions: Txn[] }>(scoped(session.householdId, "/transactions?limit=40")), [session.householdId, session.tick]);
  const [kind, setKind] = useState<AssistantKind>("create_transaction");
  const [proposal, setProposal] = useState<{ id: string; payload: Record<string, unknown>; summary: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [auditLine, setAuditLine] = useState("");
  const currency = session.currency || dash?.household.currency || "USD";
  const buckets = dash?.buckets.filter((bucket) => !bucket.systemRole) ?? [];
  function payloadFrom(data: FormData): Record<string, unknown> {
    const spaceId = dash?.spaceId;
    if (kind === "create_transaction") {
      const amount = Math.abs(parseAmount(String(data.get("amount")), currency));
      const bucketId = String(data.get("bucketId") || "");
      return {
        date: data.get("date"), accountId: data.get("accountId"), amountMinor: -amount, type: "expense", payee: data.get("payee"), bankStatus: "posted",
        splits: bucketId ? [{ bucketId, amountMinor: amount, role: "expense" }] : [],
      };
    }
    if (kind === "create_category") return { spaceId, name: data.get("name"), group: data.get("group") || "Spending", kind: data.get("categoryKind") || "expense", flexRole: data.get("flexRole") || "flexible" };
    if (kind === "set_category" || kind === "set_tags") {
      const txn = txns.data?.transactions.find((row) => row.id === data.get("transactionId"));
      return kind === "set_category"
        ? { transactionId: data.get("transactionId"), version: txn?.version ?? 1, bucketId: data.get("bucketId") }
        : { transactionId: data.get("transactionId"), version: txn?.version ?? 1, tags: String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean) };
    }
    if (kind === "create_rule") {
      return {
        spaceId, name: data.get("name"), priority: 50, matchMode: "all",
        conditions: [{ field: "payee", op: "contains", value: data.get("payee") }],
        actions: [{ type: "add_tag", value: data.get("tag") }],
      };
    }
    if (kind === "create_goal") {
      return { spaceId, name: data.get("name"), bucketId: data.get("bucketId"), targetMinor: Math.abs(parseAmount(String(data.get("amount")), currency)), purpose: "goal", targetDate: data.get("date") || undefined };
    }
    return { spaceId, bucketId: data.get("bucketId"), periodKey: dash?.budget.periodKey, amountMinor: Math.abs(parseAmount(String(data.get("amount")), currency)), planRevision: dash?.household.planRevision ?? 0 };
  }
  function describe(nextKind: AssistantKind, payload: Record<string, unknown>) {
    const account = dash?.accounts.find((row) => row.id === payload.accountId)?.name ?? "the selected account";
    const bucket = buckets.find((row) => row.id === payload.bucketId)?.name ?? "the selected category";
    const txn = txns.data?.transactions.find((row) => row.id === payload.transactionId);
    if (nextKind === "create_transaction") return `Expense ${formatMoney(Math.abs(Number(payload.amountMinor)), currency)} to ${String(payload.payee)} on ${String(payload.date)} from ${account}.`;
    if (nextKind === "create_category") return `New ${String(payload.kind)} category ${String(payload.name)} in ${String(payload.group)}, ${String(payload.flexRole)}.`;
    if (nextKind === "set_category") return `Set ${txn?.payee ?? "that transaction"} to ${bucket}.`;
    if (nextKind === "set_tags") return `Set tags on ${txn?.payee ?? "that transaction"} to ${(payload.tags as string[]).join(", ") || "none"}.`;
    if (nextKind === "create_rule") return `Rule ${String(payload.name)} adds the tag ${String((payload.actions as { value?: string }[])[0]?.value)} when the payee contains ${String((payload.conditions as { value?: string }[])[0]?.value)}.`;
    if (nextKind === "create_goal") return `Goal ${String(payload.name)} for ${formatMoney(Number(payload.targetMinor), currency)} on ${bucket}.`;
    return `Assign ${formatMoney(Number(payload.amountMinor), currency)} to ${bucket} for ${String(payload.periodKey)}.`;
  }
  async function rememberAudit(actionName: string) {
    const audit = await api<{ events: { action: string; summary: string }[] }>(scoped(session.householdId, "/audit"));
    setAuditLine(audit.events.find((event) => event.action === actionName)?.summary ?? "");
  }
  return (
    <form id="assistant-action-fields" className="card" style={{ marginTop: 16 }} onSubmit={(event) => action.run(event, async () => {
      const payload = payloadFrom(new FormData(event.currentTarget));
      const preview = await api<{ id: string; note: string }>(scoped(session.householdId, "/assistant/actions/preview"), { method: "POST", body: JSON.stringify({ kind, payload }) });
      setProposal({ id: preview.id, payload, summary: describe(kind, payload) });
      setConfirmed(false);
      setNote(`${preview.note} ${describe(kind, payload)}`);
      setAuditLine("");
    })}>
      <h2>Propose a change</h2>
      <p className="muted">Preview does not save. Edit the fields and preview again before confirming. Confirm uses the same save path as the rest of the household, and undo is refused after something else changes that record.</p>
      <div className="row" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {ASSISTANT_KINDS.map(([id, label]) => <button className={kind === id ? "btn" : "btn-secondary"} key={id} type="button" onClick={() => { setKind(id); setProposal(null); setConfirmed(false); setNote(""); setAuditLine(""); }}>{label}</button>)}
      </div>
      {kind === "create_transaction" ? <>
        <Field label="Payee"><input name="payee" required /></Field>
        <Field label="Amount"><input name="amount" required inputMode="decimal" /></Field>
        <Field label="Date"><input name="date" type="date" required defaultValue="2026-11-12" /></Field>
        <Field label="Account"><select name="accountId" required>{dash?.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        <Field label="Category"><select name="bucketId"><option value="">Leave uncategorized</option>{buckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
      </> : null}
      {kind === "create_category" ? <>
        <Field label="Name"><input name="name" required /></Field>
        <Field label="Group"><input name="group" defaultValue="Spending" /></Field>
        <Field label="Kind"><select name="categoryKind"><option value="expense">Expense</option><option value="income">Income</option></select></Field>
        <Field label="Role"><select name="flexRole"><option value="flexible">Flexible</option><option value="fixed">Fixed</option><option value="non_monthly">Non-monthly</option></select></Field>
      </> : null}
      {kind === "set_category" || kind === "set_tags" ? <>
        <Field label="Transaction"><select name="transactionId" required>{txns.data?.transactions.map((txn) => <option key={txn.id} value={txn.id}>{txn.date} {txn.payee}</option>)}</select></Field>
        {kind === "set_category" ? <Field label="Category"><select name="bucketId" required>{buckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field> : <Field label="Tags"><input name="tags" required placeholder="food, weekly" /></Field>}
      </> : null}
      {kind === "create_rule" ? <>
        <Field label="Rule name"><input name="name" required /></Field>
        <Field label="Payee contains"><input name="payee" required /></Field>
        <Field label="Tag to add"><input name="tag" required defaultValue="food" /></Field>
      </> : null}
      {kind === "create_goal" ? <>
        <Field label="Goal name"><input name="name" required /></Field>
        <Field label="Envelope"><select name="bucketId" required>{buckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="Target"><input name="amount" required inputMode="decimal" /></Field>
        <Field label="Target date"><input name="date" type="date" /></Field>
      </> : null}
      {kind === "adjust_plan" ? <>
        <Field label="Category"><select name="bucketId" required>{buckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="Assigned amount"><input name="amount" required inputMode="decimal" /></Field>
        <p className="muted">Period {dash?.budget.periodKey}. Plan revision {dash?.household.planRevision ?? 0}. A stale revision is refused and nothing is assigned.</p>
      </> : null}
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      {note ? <Notice>{note}</Notice> : null}
      {auditLine ? <p>Audit: {auditLine}</p> : null}
      <button className="btn" type="submit">Preview</button>
      {proposal ? <button className="btn" type="button" onClick={async (event) => {
        const form = event.currentTarget.form;
        if (!form) return;
        try {
          const current = payloadFrom(new FormData(form));
          if (JSON.stringify(current) !== JSON.stringify(proposal.payload)) {
            setNote("Those fields changed. Preview again. Nothing was saved.");
            return;
          }
          const confirmedResult = await api<{ note: string }>(scoped(session.householdId, `/assistant/actions/${proposal.id}/confirm`), { method: "POST" });
          setConfirmed(true);
          setNote(confirmedResult.note);
          await rememberAudit("assistant.confirm");
          session.bump();
        } catch (caught) { setNote(caught instanceof Error ? caught.message : "That did not save."); }
      }}>Confirm</button> : null}
      {proposal && confirmed ? <button className="btn-secondary" type="button" onClick={async () => {
        try {
          await api(scoped(session.householdId, `/assistant/actions/${proposal.id}/undo`), { method: "POST" });
          setConfirmed(false);
          setNote("That change was undone.");
          await rememberAudit("assistant.undo");
          session.bump();
        } catch (caught) { setNote(caught instanceof Error ? caught.message : "That was not undone."); }
      }}>Undo</button> : null}
    </form>
  );
}

type ImportSplit = { category: string; amountMinor: number; role: string };
type ImportGroup = {
  groupKey: string;
  rowNumbers: number[];
  date?: string;
  payee: string;
  amountMinor?: number;
  notes?: string;
  tags?: string[];
  splits?: ImportSplit[];
  errors: string[];
  warnings?: string[];
  duplicate: boolean;
  possibleMatch: boolean;
};
type ImportPreview = {
  batchId: string;
  rows: { rowNumber: number; date?: string; payee?: string; amountMinor?: number; notes?: string; tags?: string[]; errors: string[]; duplicate: boolean; possibleMatch: boolean; splits?: ImportSplit[] }[];
  groups: ImportGroup[];
  categories: { name: string; kind: string; count: number; conflict: boolean; ambiguous: boolean; match: { id: string; name: string } | null }[];
  balances: { account: string; date: string; balanceMinor: number }[];
  columns: Record<string, string> | null;
  explanations: string[];
  present: string[];
  note: string;
};

function columnValue(data: FormData, name: string) {
  const value = String(data.get(name) || "").trim();
  return value || undefined;
}

export function ImportPage() {
  const session = useSession();
  const access = useAccess();
  const previewRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const confirmFromAction = useRef(false);
  const accounts = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const spaceId = session.spaceId ?? accounts.data?.spaceId;
  useEffect(() => { if (accounts.data?.spaceId) session.adoptSpace(accounts.data.spaceId); }, [accounts.data?.spaceId]);
  const recent = useLoad(() => spaceId
    ? api<{ batch: { id: string; status: string; note: string; commit: Record<string, unknown> | null } | null }>(scoped(session.householdId, "/import/recent", spaceId))
    : Promise.resolve({ batch: null }), [session.householdId, spaceId, session.tick]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [categoryMap, setCategoryMap] = useState<Record<string, string>>({});
  const [createMissing, setCreateMissing] = useState(false);
  const [committed, setCommitted] = useState<{ batchId: string; body: Record<string, unknown>; note: string } | null>(null);
  const form = useFormError();
  const step = preview && committed?.batchId === preview.batchId ? "Confirm" : preview ? "Preview" : "Source";
  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview?.batchId]);
  useEffect(() => { if (committed && confirmFromAction.current) confirmRef.current?.focus(); }, [committed?.batchId, committed?.note]);
  useEffect(() => {
    const batch = recent.data?.batch;
    if (!batch?.commit) return;
    setCommitted((current) => current ?? { batchId: batch.id, body: batch.commit!, note: batch.note });
  }, [recent.data]);
  const buckets = accounts.data?.buckets.filter((bucket) => !bucket.archived) ?? [];
  function toggleRow(rowNumber: number) {
    if (!preview) return;
    const group = preview.groups.find((item) => item.rowNumbers.includes(rowNumber));
    if (!group || group.duplicate || group.errors.length) return;
    setSelected((current) => {
      const on = group.rowNumbers.every((number) => current.includes(number));
      return on ? current.filter((number) => !group.rowNumbers.includes(number)) : [...new Set([...current, ...group.rowNumbers])];
    });
  }
  async function commit(batchId: string, body: Record<string, unknown>) {
    const saved = await api<{ note: string; created: number; duplicate: boolean }>(scoped(session.householdId, `/import/${batchId}/commit`), { method: "POST", body: JSON.stringify(body) });
    confirmFromAction.current = true;
    setCommitted({ batchId, body, note: saved.note });
    session.bump();
  }
  async function runAction(action: () => Promise<void>) {
    form.setError("");
    try {
      await action();
    } catch (caught) {
      form.setError(caught instanceof Error ? caught.message : "That did not save.");
    }
  }
  return (
    <Page title="Import" lede="Choose a source, map the columns that exist, preview every row, and confirm. Categories, notes, tags, and splits are kept when the file has them. Fields that are missing stay blank.">
      <ol className="wizard-steps" aria-label="Import steps">
        <li aria-current={step === "Source" ? "step" : undefined}>1. Source and columns</li>
        <li aria-current={step === "Preview" ? "step" : undefined}>2. Preview</li>
        <li aria-current={step === "Confirm" ? "step" : undefined}>3. Confirm</li>
      </ol>
      {accounts.data ? <p>Cash <Money minor={accounts.data.budget.cashPoolMinor} /> · Ready to Assign <Money minor={accounts.data.budget.readyToAssignMinor} /> · Spending <Money minor={accounts.data.budget.spendingMinor} /></p> : null}
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      {recent.error ? <Notice kind="bad">{recent.error}</Notice> : null}
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const file = data.get("file") as File;
        const text = await file.text();
        const mapping: Record<string, string> = {};
        for (const [field, key] of [
          ["dateColumn", "date"], ["amountColumn", "amount"], ["outflowColumn", "debit"], ["inflowColumn", "credit"],
          ["payeeColumn", "payee"], ["categoryColumn", "category"], ["notesColumn", "notes"], ["tagsColumn", "tags"],
          ["splitsColumn", "splits"], ["splitGroupColumn", "splitGroup"], ["balanceColumn", "balance"], ["currencyColumn", "currency"],
        ] as const) {
          const value = columnValue(data, field);
          if (value) mapping[key] = value;
        }
        const next = await api<ImportPreview>(scoped(session.householdId, "/import/preview"), { method: "POST", body: JSON.stringify({
          spaceId: accounts.data?.spaceId,
          profile: data.get("profile") || undefined,
          format: data.get("format"),
          text,
          mapping,
          dateOrder: data.get("dateOrder"),
          decimal: data.get("decimal"),
          inflowSign: data.get("inflowSign"),
        }) });
        const chosen: number[] = [];
        for (const group of next.groups) {
          if (!group.duplicate && !group.possibleMatch && group.errors.length === 0) chosen.push(...group.rowNumbers);
        }
        const mapped: Record<string, string> = {};
        for (const category of next.categories) {
          if (category.match && !category.ambiguous && !category.conflict) mapped[category.name] = category.match.id;
        }
        setPreview(next);
        setSelected(chosen);
        setCategoryMap(mapped);
        setCreateMissing(false);
      })}>
        <h2>Source</h2>
        <fieldset>
        <legend>How to read the file</legend>
        <div className="grid two">
          <Field label="Format"><select name="format" aria-label="Format"><option value="csv">CSV</option><option value="ofx">OFX / QFX</option><option value="qif">QIF</option></select></Field>
          <Field label="Source"><select name="profile" aria-label="Source"><option value="">Generic columns</option><option value="mint">Mint</option><option value="ynab">YNAB</option><option value="monarch">Monarch</option><option value="simplifi">Simplifi</option><option value="rocket">Rocket Money</option><option value="everydollar">EveryDollar</option><option value="empower">Empower</option><option value="goodbudget">Goodbudget</option></select></Field>
          <Field label="Date order"><select name="dateOrder" aria-label="Date order"><option value="mdy">Month/day/year</option><option value="dmy">Day/month/year</option></select></Field>
          <Field label="Decimal mark"><select name="decimal" aria-label="Decimal mark"><option value="period">1,234.56</option><option value="comma">1.234,56</option></select></Field>
          <Field label="Sign"><select name="inflowSign" aria-label="Sign"><option value="positive_in">Positive amounts are income</option><option value="positive_out">Positive amounts are expenses</option></select></Field>
        </div>
        </fieldset>
        <h2>Map columns</h2>
        <fieldset>
        <legend>Columns in the file</legend>
        <p className="muted">Leave a box blank to use the source profile or a matching header. A blank field is not invented.</p>
        <div className="grid two">
          <Field label="Date column"><input name="dateColumn" aria-label="Date column" placeholder="Date" /></Field>
          <Field label="Amount column"><input name="amountColumn" aria-label="Amount column" placeholder="Amount" /></Field>
          <Field label="Outflow column"><input name="outflowColumn" aria-label="Outflow column" placeholder="Outflow" /></Field>
          <Field label="Inflow column"><input name="inflowColumn" aria-label="Inflow column" placeholder="Inflow" /></Field>
          <Field label="Payee column"><input name="payeeColumn" aria-label="Payee column" placeholder="Payee" /></Field>
          <Field label="Category column"><input name="categoryColumn" aria-label="Category column" placeholder="Category" /></Field>
          <Field label="Notes column"><input name="notesColumn" aria-label="Notes column" placeholder="Notes" /></Field>
          <Field label="Tags column"><input name="tagsColumn" aria-label="Tags column" placeholder="Tags" /></Field>
          <Field label="Splits column"><input name="splitsColumn" aria-label="Splits column" placeholder="Splits" /></Field>
          <Field label="Split group column"><input name="splitGroupColumn" aria-label="Split group column" placeholder="Split Group" /></Field>
          <Field label="Balance column"><input name="balanceColumn" aria-label="Balance column" placeholder="Balance" /></Field>
          <Field label="Currency column"><input name="currencyColumn" aria-label="Currency column" placeholder="Currency" /></Field>
        </div>
        </fieldset>
        <Field label="File"><input name="file" type="file" required accept=".csv,.ofx,.qfx,.qif,text/csv,text/plain" aria-label="Import file" /></Field>
        <button className="btn" type="submit" disabled={!accounts.data || !access.canWrite}>Preview</button>
      </form>
      {preview ? <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        if (!selected.length) throw new Error("Select at least one row. Nothing was imported.");
        const body = {
          accountId: String(data.get("accountId")),
          rowNumbers: selected,
          categoryMap: Object.fromEntries(Object.entries(categoryMap).filter(([, value]) => value)),
          createMissingCategories: createMissing,
        };
        if (preview) await commit(preview.batchId, body);
      })}>
        <h2 ref={previewRef} tabIndex={-1}>Preview</h2>
        <p>{preview.note}</p>
        <p>In this file: {preview.present.length ? preview.present.join(", ") : "no optional fields"}.</p>
        <ul>{preview.explanations.map((item) => <li key={item}>{item}</li>)}</ul>
        {preview.columns ? <p className="muted">Columns in use: {Object.entries(preview.columns).filter(([, value]) => value).map(([key, value]) => `${key} = ${value}`).join(", ")}.</p> : null}
        {preview.balances.map((balance) => <p key={`${balance.account}-${balance.date}`}>Balance in the file for {balance.account} on {balance.date}: <Money minor={balance.balanceMinor} />. This is not posted.</p>)}
        {preview.categories.length ? <div>
          <h2>Categories</h2>
          {preview.categories.map((category) => <Field key={category.name} label={category.name}>
            <select aria-label={`Category ${category.name}`} value={categoryMap[category.name] ?? ""} onChange={(event) => setCategoryMap((current) => ({ ...current, [category.name]: event.target.value }))}>
              <option value="">{category.match ? "Create if allowed" : "Not in this plan"}</option>
              {buckets.filter((bucket) => bucket.kind === category.kind).map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}
            </select>
            {category.conflict ? <span className="muted"> This name is used for both income and spending.</span> : null}
            {category.ambiguous ? <span className="muted"> More than one category has this name. Choose one.</span> : null}
          </Field>)}
          <label className="field"><span><input type="checkbox" checked={createMissing} aria-label="Create categories that are not in the plan" onChange={(event) => setCreateMissing(event.target.checked)} /> Create categories that are not in the plan</span></label>
        </div> : null}
        <Field label="Account"><select name="accountId" aria-label="Account" required>{accounts.data?.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>
        {preview.rows.slice(0, 60).map((row) => {
          const group = preview.groups.find((item) => item.rowNumbers.includes(row.rowNumber));
          const status = row.duplicate ? "Already imported" : row.possibleMatch ? "Same date, payee, and amount already in the register" : row.errors.join(" ");
          const detail = [
            row.splits?.map((split) => split.category).join(", "),
            row.notes,
            row.tags?.join(", "),
            group?.warnings?.join(" "),
          ].filter(Boolean).join(" · ");
          return <label key={row.rowNumber} className="link-row"><span><input type="checkbox" aria-label={`Import ${row.date ?? "undated"} ${row.payee || "row"}, row ${row.rowNumber}`} checked={selected.includes(row.rowNumber)} disabled={row.duplicate || row.errors.length > 0 || !access.canWrite} onChange={() => toggleRow(row.rowNumber)} /> {row.date} {row.payee} {status} {detail}</span>{row.amountMinor != null ? <Money minor={row.amountMinor} /> : null}</label>;
        })}
        {preview.rows.length > 60 ? <p>{preview.rows.length - 60} more rows stay selected when they have no error.</p> : null}
        <button className="btn" type="submit" disabled={!access.canWrite}>Import selected</button>
      </form> : null}
      {committed ? <article className="card" style={{ marginTop: 16 }} aria-label="Import result">
        <h2 ref={confirmRef} tabIndex={-1}>Confirm</h2>
        <p>{committed.note}</p>
        <div className="row">
          <button className="btn-secondary" type="button" disabled={!access.canWrite} onClick={() => runAction(async () => { await commit(committed.batchId, committed.body); })}>Confirm this import again</button>
          <button className="btn-secondary" type="button" disabled={!access.canWrite} onClick={() => runAction(async () => {
            const undone = await api<{ note: string }>(scoped(session.householdId, `/import/${committed.batchId}/revert`), { method: "POST" });
            confirmFromAction.current = true;
            setCommitted({ ...committed, note: undone.note });
            session.bump();
          })}>Undo this import</button>
        </div>
      </article> : null}
    </Page>
  );
}

export function Rules() {
  const session = useSession();
  const state = useLoad(() => api<{ rules: { id: string; name: string; match_mode: string; enabled: number }[] }>(scoped(session.householdId, "/rules")), [session.householdId, session.tick]);
  const dash = useLoad(() => api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId]);
  const form = useFormError();
  const [preview, setPreview] = useState("");
  if (!state.data) return <Loading />;
  return (
    <Page title="Rules" lede="A rule can rename a payee or suggest a category. It will not replace a category you locked.">
      <ul>{state.data.rules.map((rule) => <li key={rule.id}>{rule.name} · {rule.match_mode} · {rule.enabled ? "on" : "off"}</li>)}</ul>
      <form id="rule-form" className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/rules"), { method: "POST", body: JSON.stringify({
          name: data.get("name"), matchMode: "all", priority: 50,
          conditions: [{ field: "payee", op: "contains", value: data.get("contains") }],
          actions: [{ type: "set_bucket", value: data.get("bucketId") }, { type: "set_payee", value: data.get("payee") || undefined }].filter((action) => action.value),
        }) });
        session.bump();
      })}>
        <Field label="Name"><input name="name" required /></Field>
        <Field label="Payee contains"><input name="contains" required /></Field>
        <Field label="Set category"><select name="bucketId">{dash.data?.buckets.filter((bucket) => !bucket.systemRole).map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}</select></Field>
        <Field label="Rename payee"><input name="payee" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {preview ? <Notice>{preview}</Notice> : null}
        <button className="btn-secondary" type="button" onClick={async () => {
          const data = new FormData((document.getElementById("rule-form") as HTMLFormElement));
          const result = await api<{ missing: string[]; changes: string[]; note: string }>(scoped(session.householdId, "/rules/suggest"), { method: "POST", body: JSON.stringify({ payee: data.get("contains") || "sample", amountMinor: -1000 }) });
          setPreview(`${result.note} ${result.changes.join(" ")}${result.missing.length ? ` Missing: ${result.missing.join(", ")}.` : ""}`);
        }}>Preview</button>
        <button className="btn" type="submit">Save rule</button>
      </form>
    </Page>
  );
}

export { Household } from "./Sharing.js";

export function Providers() {
  const session = useSession();
  const state = useLoad(() => api<{ providers: { id: string; name: string; group: string; status: string; implementation?: string; needs: string; capabilities: string[] }[]; note?: string }>("/api/providers"), []);
  const dash = useLoad(() => session.householdId ? api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId)) : Promise.resolve(null), [session.householdId, session.spaceId]);
  const [note, setNote] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [attemptStatus, setAttemptStatus] = useState("");
  if (!state.data) return <Loading />;
  return (
    <Page title="Connections" lede="Connect a data source, review its history, and choose what enters your ledger. Provider setup and delivery status are listed below.">
      <BankConnection key={session.householdId} />
      <article className="card" style={{ marginBottom: 12 }}>
        <h2>Sandbox bank</h2>
        <p>Connect imports the built-in test history into Sandbox Checking. Sync posts the pending line in place and adds the next fixture. This is not your bank.</p>
        <button className="btn" type="button" disabled={!dash.data?.spaceId} onClick={async () => {
          try {
            const result = await api<{ note: string; transactionsImported: number }>(scoped(session.householdId, "/providers/sandbox/connect"), { method: "POST", body: JSON.stringify({ provider: "sandbox-bank", spaceId: dash.data?.spaceId }) });
            setNote(`${result.note} Imported ${result.transactionsImported}.`);
            session.bump();
          } catch (caught) {
            setNote(caught instanceof Error ? caught.message : "The sandbox import did not run.");
          }
        }}>Connect sandbox</button>
        <button className="btn-secondary" type="button" disabled={!dash.data?.spaceId} onClick={async () => {
          try {
            const result = await api<{ note: string; imported: number; settled: number }>(scoped(session.householdId, "/providers/sandbox/sync"), { method: "POST", body: JSON.stringify({ spaceId: dash.data?.spaceId }) });
            setNote(`${result.note} Added ${result.imported}. Settled ${result.settled}.`);
            session.bump();
          } catch (caught) {
            setNote(caught instanceof Error ? caught.message : "The sandbox sync did not run.");
          }
        }}>Sync sandbox</button>
      </article>
      <form className="card" style={{ marginBottom: 12 }} onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        try {
          await api("/api/messages/enrollment", { method: "POST", body: JSON.stringify({ channel: data.get("channel"), destinationLabel: data.get("label"), consent: true }) });
          setNote("Consent is stored. No message was sent.");
        } catch (caught) {
          setNote(caught instanceof Error ? caught.message : "Consent was not stored.");
        }
      }}>
        <h2>Message enrollment</h2>
        <p className="muted">Consent is stored even when no live provider is connected. A test sink can accept a message. Accepted is not delivered.</p>
        <Field label="Channel"><select name="channel" id="message-channel"><option value="email">Email</option><option value="sms">SMS</option><option value="push">Push</option></select></Field>
        <Field label="Label"><input name="label" required defaultValue="test inbox" /></Field>
        <button className="btn" type="submit">Save consent</button>
        <button className="btn-secondary" type="button" onClick={async () => {
          const channel = (document.getElementById("message-channel") as HTMLSelectElement).value;
          try {
            const sent = await api<{ id: string; status: string; note: string; provenDelivered: boolean }>("/api/notifications/test", { method: "POST", body: JSON.stringify({ channel, outcome: "rejected" }) });
            setAttemptId(sent.id);
            setAttemptStatus(sent.status);
            setNote(`${sent.status}. ${sent.note} Proven delivered: ${sent.provenDelivered}.`);
          } catch (caught) { setNote(caught instanceof Error ? caught.message : "The test was not sent."); }
        }}>Send a rejected test</button>
        <button className="btn-secondary" type="button" disabled={!attemptId || attemptStatus !== "failed"} onClick={async () => {
          try {
            const retried = await api<{ id: string; status: string; note: string; provenDelivered: boolean }>(`/api/notifications/test/${attemptId}/retry`, { method: "POST" });
            setAttemptId(retried.id);
            setAttemptStatus(retried.status);
            setNote(`Retry ${retried.status}. ${retried.note} Proven delivered: ${retried.provenDelivered}.`);
          } catch (caught) { setNote(caught instanceof Error ? caught.message : "That was not retried."); }
        }}>Retry failed test</button>
        <button className="btn-secondary" type="button" onClick={async () => {
          const channel = (document.getElementById("message-channel") as HTMLSelectElement).value;
          try {
            const opted = await api<{ note: string }>("/api/messages/opt-out", { method: "POST", body: JSON.stringify({ channel }) });
            setNote(opted.note);
          } catch (caught) { setNote(caught instanceof Error ? caught.message : "Opt-out was not saved."); }
        }}>Opt out</button>
      </form>
      <LiveMessageTests />
      {note ? <Notice>{note}</Notice> : null}
      {state.data.note ? <p className="muted">{state.data.note}</p> : null}
      {state.data.providers.map((provider) => (
        <article key={provider.id} className="card" style={{ marginBottom: 12 }}>
          <div className="link-row"><h2>{provider.name}</h2><span>{provider.status.replaceAll("_", " ")}</span></div>
          <p className="muted">{provider.group} · {provider.implementation ?? provider.status} · {provider.capabilities.join(", ")}</p>
          <p>{provider.needs}</p>
        </article>
      ))}
    </Page>
  );
}

export function Cases() {
  const session = useSession();
  const state = useLoad(() => api<{ cases: { id: string; merchant: string; kind: string; status: string }[] }>(scoped(session.householdId, "/cases")), [session.householdId, session.tick]);
  const form = useFormError();
  const [note, setNote] = useState("");
  return (
    <Page title="Requests" lede="Saving a request records your authorization. It does not contact a biller, cancel a subscription, or negotiate a bill.">
      <ul>{state.data?.cases.map((item) => <li key={item.id}>{item.merchant} · {item.kind} · {item.status.replaceAll("_", " ")}</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const result = await api<{ provider: string }>(scoped(session.householdId, "/cases"), { method: "POST", body: JSON.stringify({ kind: data.get("kind"), merchant: data.get("merchant"), authorized: data.get("authorized") === "on" }) });
        setNote(result.provider);
        session.bump();
      })}>
        <Field label="Kind"><select name="kind"><option value="cancellation">Cancellation</option><option value="negotiation">Negotiation</option><option value="refund_review">Refund review</option></select></Field>
        <Field label="Merchant"><input name="merchant" required /></Field>
        <label className="field"><span><input type="checkbox" name="authorized" required /> I authorize storing this request. I understand no provider is connected.</span></label>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <button className="btn" type="submit">Record request</button>
      </form>
    </Page>
  );
}

export function Credit() {
  const session = useSession();
  const state = useLoad(() => api<{ entries: { id: string; score: number; model: string; source: string; report_date: string }[]; liveReport: null; note: string }>(scoped(session.householdId, "/credit")), [session.householdId, session.tick]);
  const form = useFormError();
  if (!state.data) return <Loading />;
  return (
    <Page title="Credit" lede={state.data.note}>
      {state.data.liveReport === null ? <p className="muted">No live report is attached.</p> : null}
      <ul>{state.data.entries.map((entry) => <li key={entry.id}>{entry.report_date} · {entry.score} · {entry.model} · {entry.source}</li>)}</ul>
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, "/credit"), { method: "POST", body: JSON.stringify({ score: Number(data.get("score")), model: data.get("model"), note: data.get("note") }) });
        session.bump();
      })}>
        <Field label="Score"><input name="score" type="number" min={300} max={850} required /></Field>
        <Field label="Model"><input name="model" defaultValue="Manual entry" /></Field>
        <Field label="Note"><input name="note" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save manual score</button>
      </form>
    </Page>
  );
}

export function Learn() {
  const state = useLoad(() => api<{ lessons: { id: string; title: string; topic: string; minutes: number; body: string; completed: boolean; quiz: { question: string; choices: string[]; answer: number; explanation: string }[] }[] }>("/api/lessons"), []);
  const guide = useLoad(() => api<{ tours: { id: string; title: string; steps: string[] }[]; practice: { id: string; prompt: string }[]; progress: { item_id: string; step: number; kind: string }[]; note: string }>("/api/learn"), []);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  if (!state.data) return <Loading />;
  return (
    <Page title="Learn" lede="These lessons were written for BudgetCents. Completing one does not enroll you with a coach.">
      {state.data.lessons.map((lesson) => (
        <article key={lesson.id} className="card" style={{ marginBottom: 12 }}>
          <h2>{lesson.title}</h2>
          <p className="muted">{lesson.topic} · {lesson.minutes} min{lesson.completed ? " · completed" : ""}</p>
          <p>{lesson.body}</p>
          {lesson.quiz.map((quiz) => (
            <fieldset key={quiz.question}>
              <legend>{quiz.question}</legend>
              {quiz.choices.map((choice, index) => <label key={choice} className="field"><span><input type="radio" name={lesson.id} onChange={() => setPicked({ ...picked, [lesson.id]: index })} /> {choice}</span></label>)}
              <button className="btn-secondary" type="button" onClick={async () => {
                if (picked[lesson.id] !== quiz.answer) { setNote(quiz.explanation); return; }
                await api(`/api/lessons/${lesson.id}/complete`, { method: "POST", body: JSON.stringify({ score: 1 }) });
                setNote(quiz.explanation);
              }}>Check</button>
            </fieldset>
          ))}
        </article>
      ))}
      {note ? <Notice>{note}</Notice> : null}
      <h2>Guided tours</h2>
      <p className="muted">{guide.data?.note}</p>
      {(guide.data?.tours ?? []).map((tour) => (
        <article key={tour.id} className="card">
          <h3>{tour.title}</h3>
          <ol>{tour.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="muted">Saved step: {guide.data?.progress.find((item) => item.item_id === tour.id)?.step ?? 0}</p>
          <button className="btn-secondary" type="button" onClick={async () => {
            const current = guide.data?.progress.find((item) => item.item_id === tour.id)?.step ?? 0;
            await api("/api/learn/tours", { method: "POST", body: JSON.stringify({ itemId: tour.id, step: Math.min(current + 1, tour.steps.length) }) });
            setNote("Tour progress is saved. No money moved.");
          }}>Save this step</button>
        </article>
      ))}
      {(guide.data?.practice ?? []).map((item) => (
        <form key={item.id} className="card" onSubmit={async (event) => {
          event.preventDefault();
          const result = await api<{ correct: boolean; note: string }>("/api/learn/practice", { method: "POST", body: JSON.stringify({ itemId: item.id, answerMinor: parseAmount(answer || "0", "USD") }) });
          setNote(result.note);
        }}>
          <h3>Practice</h3>
          <p>{item.prompt}</p>
          <Field label="Answer in dollars"><input value={answer} onChange={(event) => setAnswer(event.target.value)} inputMode="decimal" /></Field>
          <button className="btn" type="submit">Check answer</button>
        </form>
      ))}
    </Page>
  );
}

export function Checklists() {
  const session = useSession();
  const [kind, setKind] = useState("estate");
  const state = useLoad(() => api<{ items: { id: string; title: string; done: number }[] }>(scoped(session.householdId, `/checklists/${kind}`)), [session.householdId, kind, session.tick]);
  const form = useFormError();
  return (
    <Page title="Checklists" lede="Tax and estate lists organize your own tasks. A checked item is not a filed return or an executed will.">
      <div className="chips">{["estate", "tax", "business"].map((item) => <button key={item} className="chip" aria-pressed={kind === item} onClick={() => setKind(item)}>{item}</button>)}</div>
      <ul>{state.data?.items.map((item) => <li key={item.id}><label><input type="checkbox" checked={item.done === 1} onChange={async (event) => { await api(scoped(session.householdId, `/checklists/${kind}`), { method: "POST", body: JSON.stringify({ id: item.id, title: item.title, done: event.target.checked }) }); session.bump(); }} /> {item.title}</label></li>)}</ul>
      <form onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await api(scoped(session.householdId, `/checklists/${kind}`), { method: "POST", body: JSON.stringify({ title: data.get("title") }) });
        session.bump();
      })}>
        <Field label="Add item"><input name="title" required /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Add</button>
      </form>
    </Page>
  );
}

export function Settings() {
  const session = useSession();
  const sessions = useLoad(() => api<{ sessions: { id: string; device_label: string | null; created_at: string; revoked_at: string | null; current: boolean }[] }>("/api/auth/sessions"), [session.tick]);
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState("");
  const form = useFormError();
  if (!session.user) return null;
  return (
    <Page title="Settings" lede="Sign-in, privacy, export, and deletion. Mail stays in the local outbox until SMTP is configured.">
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        await session.patchMe({ displayName: data.get("displayName"), theme: data.get("theme"), aiEnabled: data.get("ai") === "on", labelMode: data.get("labelMode") });
        setSaved("Settings saved.");
      })}>
        <Field label="Name"><input name="displayName" defaultValue={session.user.displayName} /></Field>
        <Field label="Theme"><select name="theme" defaultValue={session.user.theme}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
        <Field label="Labels"><select name="labelMode" defaultValue={session.user.labelMode}><option value="categories">Categories</option><option value="envelopes">Envelopes</option></select></Field>
        <label className="field"><span><input type="checkbox" name="ai" defaultChecked={session.user.aiEnabled} /> Assistant can answer from ledger facts</span></label>
        {saved ? <Notice>{saved}</Notice> : null}
        <button className="btn" type="submit">Save</button>
      </form>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Authenticator</h2>
        <p className="muted">The password is required again for this change. A signed-in session by itself cannot replace the authenticator.</p>
        <Field label="Current password"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></Field>
        {!session.user.mfaEnabled ? <button className="btn-secondary" onClick={async () => {
          setSecret("");
          try {
            const result = await api<{ secret: string }>("/api/auth/mfa/setup", { method: "POST", body: JSON.stringify({ password }) });
            setSecret(result.secret);
          } catch (caught) { form.setError(caught instanceof Error ? caught.message : "Setup did not start."); }
        }}>Start setup</button> : <button className="btn-secondary" onClick={async () => {
          try {
            await api("/api/auth/mfa/disable", { method: "POST", body: JSON.stringify({ password }) });
            setSecret("");
            setCodes([]);
            await session.refresh();
          } catch (caught) { form.setError(caught instanceof Error ? caught.message : "The authenticator was not turned off."); }
        }}>Turn off authenticator</button>}
        {secret ? <form onSubmit={(event) => form.run(event, async () => {
          const data = new FormData(event.currentTarget);
          const result = await api<{ recoveryCodes: string[] }>("/api/auth/mfa/enable", { method: "POST", body: JSON.stringify({ password, code: data.get("code") }) });
          setCodes(result.recoveryCodes);
          setSecret("");
          await session.refresh();
        })}><p>Add this secret to an authenticator, then enter a new code from that app. Authenticator secret {secret}</p><Field label="Authentication code"><input name="code" required inputMode="numeric" autoComplete="one-time-code" /></Field><button className="btn" type="submit">Enable authenticator</button></form> : null}
        {codes.length ? <Notice>Recovery codes, shown once: {codes.join(", ")}</Notice> : null}
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Sessions</h2>
        <ul>{sessions.data?.sessions.filter((item) => !item.revoked_at).map((item) => <li key={item.id}>{item.current ? "This session" : item.device_label || "Session"} · {item.created_at} <button className="btn-quiet" type="button" aria-label={item.current ? "Sign out this session" : `Revoke ${item.device_label || "session"} from ${item.created_at}`} onClick={async () => {
          const result = await api<{ current: boolean }>(`/api/auth/sessions/${item.id}`, { method: "DELETE" });
          if (result.current) await session.signOut();
          else session.bump();
        }}>{item.current ? "Sign out this session" : "Revoke"}</button></li>)}</ul>
        <button className="btn-secondary" onClick={async () => { const result = await api<{ token: string }>("/api/api-tokens", { method: "POST", body: JSON.stringify({ name: "Personal token" }) }); setToken(result.token); }}>Create API token</button>
        {token ? <Notice>Copy this token now. It is stored only as a hash. {token}</Notice> : null}
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Your data</h2>
        <RestoreBackup />
        <div className="row">
          <button className="btn-secondary" onClick={() => downloadFile(scoped(session.householdId, "/backup"), "budgetcents-backup.json")}>Download backup</button>
          <button className="btn-secondary" onClick={async () => {
            if (!window.confirm("Archive assignments and keep transactions?")) return;
            const dash = await api<Dashboard>(scoped(session.householdId, "/dashboard", session.spaceId));
            await api(scoped(session.householdId, "/fresh-start"), { method: "POST", body: JSON.stringify({ spaceId: dash.spaceId, keepTargets: true }) });
            session.bump();
          }}>Fresh start</button>
        </div>
        <DeleteAccount />
      </section>
      <Support />
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
    </Page>
  );
}

function RestoreBackup() {
  const session = useSession();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ backup: unknown; adds: Record<string, number>; skipped: number; warnings: string[]; note: string } | null>(null);
  const [done, setDone] = useState("");
  return (
    <div>
      <label className="btn-secondary file-button">Choose a backup file<input name="backup" type="file" accept="application/json,.json" aria-label="Choose a backup file" onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        setError("");
        setDone("");
        setPreview(null);
        if (!file) return;
        try {
          const backup = JSON.parse(await file.text()) as unknown;
          const result = await api<{ adds: Record<string, number>; skipped: number; warnings: string[]; note: string }>(scoped(session.householdId, "/restore"), { method: "POST", body: JSON.stringify({ mode: "preview", backup }) });
          setPreview({ backup, ...result });
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : "That file could not be read.";
          setError(`${reason} Nothing was changed.`);
        }
      }} /></label>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {preview ? (
        <div>
          <p>{preview.note} This preview did not write anything. Would add {Object.entries(preview.adds).map(([name, count]) => `${name} ${count}`).join(", ") || "nothing"}. Skipped {preview.skipped}. {preview.warnings.join(" ")}</p>
          <button className="btn" type="button" onClick={async () => {
            setError("");
            try {
              await api(scoped(session.householdId, "/restore"), { method: "POST", body: JSON.stringify({ mode: "add-missing", backup: preview.backup }) });
              setPreview(null);
              setDone("Missing rows were added. Running the same file again does not create a second copy.");
              session.bump();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "The restore was rejected. Nothing was changed.");
            }
          }}>Add the missing rows</button>
        </div>
      ) : null}
      {done ? <Notice>{done}</Notice> : null}
    </div>
  );
}

export function DeleteAccount() {
  const form = useFormError();
  return (
    <form style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      const confirm = String(data.get("confirm") ?? "");
      if (confirm !== "DELETE") throw new Error("Type DELETE to confirm.");
      await api("/api/me", { method: "DELETE", body: JSON.stringify({ password: data.get("password"), confirm }) });
      clearLocalSession();
      window.location.assign("/login");
    })}>
      <h3>Delete account</h3>
      <p className="muted">This deletes your user, sessions, and unused verification or reset links. A household you alone own is deleted with its transactions and attachments. A household you own with other members is kept until you leave it. Other people’s households stay. Signing out, or deleting the app, does not do this.</p>
      <Field label="Password"><input name="password" type="password" required /></Field>
      <Field label="Type DELETE"><input name="confirm" required pattern="DELETE" /></Field>
      {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
      <button className="btn-danger" type="submit">Delete my account</button>
    </form>
  );
}

function Support() {
  const form = useFormError();
  const [note, setNote] = useState("");
  return (
    <form className="card" style={{ marginTop: 16 }} onSubmit={(event) => form.run(event, async () => {
      const data = new FormData(event.currentTarget);
      const result = await api<{ note: string }>("/api/support", { method: "POST", body: JSON.stringify({ subject: data.get("subject"), body: data.get("body") }) });
      setNote(result.note);
    })}>
      <h2>Support</h2>
      <Field label="Subject"><input name="subject" required /></Field>
      <Field label="Message"><textarea name="body" required /></Field>
      {note ? <Notice>{note}</Notice> : null}
      <button className="btn-secondary" type="submit">Save request</button>
    </form>
  );
}

export function HelpCenter() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const articles = useLoad(() => api<{ articles: { id: string; title: string; body: string }[]; note: string }>(`/api/help?q=${encodeURIComponent(query)}`), [query]);
  const tickets = useLoad(() => api<{ tickets: { id: string; subject: string; status: string }[] }>("/api/support"), []);
  const form = useFormError();
  return (
    <Page title="Help" lede="Search the guidance written for BudgetCents. A saved request is not a reply from a person, and it is not an appointment.">
      <form role="search" className="row" onSubmit={(event) => { event.preventDefault(); setQuery(q); }}>
        <Field label="Search help"><input value={q} onChange={(event) => setQ(event.target.value)} /></Field>
        <button className="btn" type="submit">Search</button>
      </form>
      {articles.loading ? <Loading label="Loading help" /> : null}
      {articles.data?.note ? <p className="muted">{articles.data.note}</p> : null}
      {(articles.data?.articles ?? []).map((article) => <article key={article.id} className="card"><h2>{article.title}</h2><p>{article.body}</p></article>)}
      {articles.data && articles.data.articles.length === 0 ? <p>No articles match that search.</p> : null}
      <h2>Your requests</h2>
      {(tickets.data?.tickets ?? []).length === 0 ? <p className="muted">No stored requests yet.</p> : <ul>{tickets.data?.tickets.map((ticket) => <li key={ticket.id}>{ticket.subject} — {ticket.status} <button className="btn-secondary" type="button" onClick={async () => { await api(`/api/support/${ticket.id}/status`, { method: "POST", body: JSON.stringify({ status: ticket.status === "closed" ? "open" : "closed" }) }); window.location.assign("/help"); }}>{ticket.status === "closed" ? "Reopen" : "Close"}</button></li>)}</ul>}
      <form className="card" onSubmit={(event) => form.run(event, async () => {
        const data = new FormData(event.currentTarget);
        const created = await api<{ id: string; note: string }>("/api/support", { method: "POST", body: JSON.stringify({ subject: data.get("subject"), body: data.get("body") }) });
        if (String(data.get("followup") || "").trim()) {
          await api(`/api/support/${created.id}/messages`, { method: "POST", body: JSON.stringify({ body: data.get("followup") }) });
        }
        const file = data.get("file");
        if (file instanceof File && file.size) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          bytes.forEach((value) => { binary += String.fromCharCode(value); });
          await api(`/api/support/${created.id}/attachments`, { method: "POST", body: JSON.stringify({ filename: file.name || "note.txt", contentType: file.type === "image/png" || file.type === "image/jpeg" ? file.type : "text/plain", dataBase64: btoa(binary) }) });
        }
        window.location.assign("/help");
      })}>
        <Field label="Subject"><input name="subject" required /></Field>
        <Field label="What happened"><textarea name="body" required /></Field>
        <Field label="Another detail, optional"><textarea name="followup" /></Field>
        <Field label="Text or image, optional"><input name="file" type="file" accept="text/plain,image/png,image/jpeg" /></Field>
        {form.error ? <Notice kind="bad">{form.error}</Notice> : null}
        <button className="btn" type="submit">Save request</button>
      </form>
    </Page>
  );
}
