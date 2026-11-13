import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { minorToInput, parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";

interface ReceiptLine {
  id?: string;
  description: string;
  quantityMilli?: number | null;
  unitMinor?: number | null;
  amountMinor: number | null;
  bucketId?: string | null;
  unresolved?: string | null;
}

interface ReceiptFields {
  merchant: string | null;
  date: string | null;
  dateUnresolved: string | null;
  currency: string | null;
  currencyUnresolved: string | null;
  subtotalMinor: number | null;
  taxMinor: number | null;
  tipMinor: number | null;
  discountMinor: number | null;
  otherChargesMinor: number | null;
  totalMinor: number | null;
  totalUnresolved: string | null;
  taxInclusive?: boolean;
  allocationMode?: "proportional" | "category";
  allocationBucketId?: string | null;
  reviewedAdjustment?: { amountMinor: number; bucketId: string; note: string } | null;
  extractedLines?: ReceiptLine[];
  lineItems: ReceiptLine[];
  lineSumMinor: number | null;
  lineVersusSubtotal: "matches" | "differs" | "incomplete";
  lineVersusTotal: "matches" | "differs" | "incomplete";
}

interface DraftLine {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  amount: string;
  bucketId: string;
}

interface Proposal {
  reconciled: boolean;
  message: string;
  splits: { bucketId: string; amountMinor: number; role: string }[];
  categoryTotals: { bucketId: string; amountMinor: number }[];
  differenceMinor: number;
  expectedMinor: number;
  lineSumMinor: number;
}

interface Draft {
  attachmentId: string;
  status: string;
  version: number;
  engine: string | null;
  source: string | null;
  confidence: number | null;
  confidenceNote: string | null;
  userEdited: boolean;
  transactionId: string | null;
  error: string | null;
  fields: ReceiptFields;
  rawText?: string | null;
}

interface Detail {
  draft: Draft;
  possibleDuplicates: { attachmentId: string; status: string }[];
  possibleTransactions: { id: string; date: string; payee: string; amountMinor: number; currency: string; version: number; accountId: string; reconciled: boolean; reason: string }[];
  differences: { code: string; message: string }[];
  reader: { available: boolean; version: string | null; onDevice: boolean; note: string };
}

const STATUS: Record<string, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  ready: "Ready for review",
  failed: "Failed",
  confirmed: "Confirmed",
  discarded: "Discarded",
};

function quantityText(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const frac = Math.abs(milli % 1000);
  if (!frac) return String(whole);
  return `${whole}.${String(frac).padStart(3, "0").replace(/0+$/, "")}`;
}

function quantityMilli(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) throw new Error("Enter the quantity with up to three decimal places.");
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
}

export function Receipts() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const list = useLoad(() => api<{ receipts: Draft[]; reader: Detail["reader"] }>(scoped(session.householdId, "/receipts")), [session.householdId, session.tick]);
  const dash = useLoad(() => api<{ accounts: { id: string; name: string; kind: string; currency: string }[]; buckets: { id: string; name: string; kind: string; systemRole?: string | null }[] }>(scoped(session.householdId, "/dashboard", session.spaceId)), [session.householdId, session.spaceId, session.tick]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [preview, setPreview] = useState<{ url: string; type: string } | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState("");
  const [currency, setCurrency] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");
  const [tip, setTip] = useState("");
  const [discount, setDiscount] = useState("");
  const [otherCharges, setOtherCharges] = useState("");
  const [total, setTotal] = useState("");
  const [taxInclusive, setTaxInclusive] = useState(false);
  const [allocationMode, setAllocationMode] = useState<"proportional" | "category">("proportional");
  const [allocationBucketId, setAllocationBucketId] = useState("");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [adjustmentBucketId, setAdjustmentBucketId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [accountId, setAccountId] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [opId, setOpId] = useState(() => crypto.randomUUID());
  const [acceptLine, setAcceptLine] = useState(false);
  const [acceptCurrency, setAcceptCurrency] = useState(false);
  const [acceptTotal, setAcceptTotal] = useState(false);
  const [acceptDate, setAcceptDate] = useState(false);
  const [replaceSplits, setReplaceSplits] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [linkPreview, setLinkPreview] = useState("");

  async function openReceipt(id: string) {
    setError("");
    const loaded = await api<Detail>(scoped(session.householdId, `/attachments/${id}`));
    setDetail(loaded);
    const fields = loaded.draft.fields;
    setMerchant(fields.merchant ?? "");
    setDate(fields.date ?? "");
    setCurrency(fields.currency ?? "");
    setSubtotal(fields.subtotalMinor == null ? "" : minorToInput(fields.subtotalMinor));
    setTax(fields.taxMinor == null ? "" : minorToInput(fields.taxMinor));
    setTip(fields.tipMinor == null ? "" : minorToInput(fields.tipMinor));
    setDiscount(fields.discountMinor == null ? "" : minorToInput(fields.discountMinor));
    setOtherCharges(fields.otherChargesMinor == null ? "" : minorToInput(fields.otherChargesMinor));
    setTotal(fields.totalMinor == null ? "" : minorToInput(fields.totalMinor));
    setTaxInclusive(fields.taxInclusive === true);
    setAllocationMode(fields.allocationMode === "category" ? "category" : "proportional");
    setAllocationBucketId(fields.allocationBucketId ?? "");
    setAdjustmentAmount(fields.reviewedAdjustment ? minorToInput(fields.reviewedAdjustment.amountMinor) : "");
    setAdjustmentNote(fields.reviewedAdjustment?.note ?? "");
    setAdjustmentBucketId(fields.reviewedAdjustment?.bucketId ?? "");
    setLines((fields.lineItems ?? []).map((line) => ({
      id: line.id || crypto.randomUUID().slice(0, 8),
      description: line.description,
      quantity: line.quantityMilli == null ? "" : quantityText(line.quantityMilli),
      unit: line.unitMinor == null ? "" : minorToInput(line.unitMinor),
      amount: line.amountMinor == null ? "" : minorToInput(line.amountMinor),
      bucketId: line.bucketId ?? "",
    })));
    setProposal(null);
    setAcceptLine(false);
    setAcceptCurrency(false);
    setAcceptTotal(false);
    setAcceptDate(false);
    setReplaceSplits(false);
    setLinkPreview("");
    const token = localStorage.getItem("budgetcents.token");
    const response = await fetch(scoped(session.householdId, `/attachments/${id}/file`), { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error("The receipt preview could not be opened.");
    const blob = await response.blob();
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return { url: URL.createObjectURL(blob), type: response.headers.get("content-type") ?? blob.type };
    });
    return loaded;
  }

  useEffect(() => {
    if (!selected || !session.householdId) return;
    setResult("");
    setOpId(crypto.randomUUID());
    openReceipt(selected).catch((caught: Error) => setError(caught.message));
    return () => setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    // Reload when the selected receipt or the household changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, session.householdId]);

  if (list.loading && !list.data) return <Loading label="Opening receipts" />;
  if (!list.data) return <ErrorNote message={list.error ?? "Receipts did not load"} onRetry={session.bump} />;
  const accounts = (dash.data?.accounts ?? []).filter((account) => ["checking", "savings", "cash"].includes(account.kind));
  const categories = (dash.data?.buckets ?? []).filter((bucket) => bucket.kind === "expense" && !bucket.systemRole);
  const account = accounts.find((item) => item.id === accountId);
  const fields = detail?.draft.fields;
  const lineMismatch = fields?.lineVersusTotal === "differs" || fields?.lineVersusSubtotal === "differs";
  const currencyMismatch = !!fields?.currency && !!account && fields.currency !== account.currency;
  const categorized = lines.some((line) => line.bucketId);
  const code = currency || session.currency;

  function minorOrNull(text: string): number | null {
    return text.trim() ? parseAmount(text, code) : null;
  }

  function categoryName(id: string) {
    return categories.find((item) => item.id === id)?.name ?? "Category";
  }

  function draftFields() {
    return {
      merchant: merchant || null,
      date: date || null,
      currency: currency || null,
      subtotalMinor: minorOrNull(subtotal),
      taxMinor: minorOrNull(tax),
      tipMinor: minorOrNull(tip),
      discountMinor: minorOrNull(discount),
      otherChargesMinor: minorOrNull(otherCharges),
      totalMinor: minorOrNull(total),
      taxInclusive,
      allocationMode,
      allocationBucketId: allocationBucketId || null,
      reviewedAdjustment: adjustmentAmount.trim()
        ? { amountMinor: parseAmount(adjustmentAmount, code), bucketId: adjustmentBucketId, note: adjustmentNote }
        : null,
      lineItems: lines.filter((line) => line.description || line.amount || line.quantity || line.unit).map((line) => ({
        id: line.id,
        description: line.description,
        quantityMilli: quantityMilli(line.quantity),
        unitMinor: line.unit.trim() ? parseAmount(line.unit, code) : null,
        amountMinor: line.amount.trim() ? parseAmount(line.amount, code) : null,
        bucketId: line.bucketId || null,
      })),
    };
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setProposal(null);
    setLines(lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  }

  const lineSubtotals = new Map<string, number>();
  for (const line of lines) {
    if (!line.bucketId || !line.amount.trim()) continue;
    try {
      lineSubtotals.set(line.bucketId, (lineSubtotals.get(line.bucketId) ?? 0) + parseAmount(line.amount, code));
    } catch {
      // The amount is still being typed.
    }
  }

  async function upload(file: File) {
    setBusy("Uploading");
    setError("");
    const body = new FormData();
    body.set("file", file);
    const token = localStorage.getItem("budgetcents.token");
    const response = await fetch(scoped(session.householdId, "/attachments"), { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "The receipt was not stored.");
    session.bump();
    setParams({ id: payload.id });
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy("");
    }
  }

  async function saveDraft(): Promise<Detail> {
    if (!detail || !selected) throw new Error("Open a receipt first.");
    await api(scoped(session.householdId, `/attachments/${selected}/draft`), {
      method: "PATCH",
      body: JSON.stringify({ version: detail.draft.version, fields: draftFields() }),
    });
    session.bump();
    return openReceipt(selected);
  }

  return (
    <Page title="Receipts" lede="A receipt is evidence. Reading it does not change cash, Ready to Assign, or a confirmed transaction. You confirm before anything is posted.">
      <Notice>{list.data.reader.note}</Notice>
      <form className="card" onSubmit={(event) => {
        event.preventDefault();
        const file = new FormData(event.currentTarget).get("file");
        if (!(file instanceof File) || !file.size) return;
        run("Uploading", () => upload(file));
      }}>
        <h2>Upload a receipt</h2>
        <Field label="JPEG, PNG, or PDF"><input name="file" type="file" accept="image/jpeg,image/png,application/pdf" required /></Field>
        <button className="btn" type="submit" disabled={!!busy}>Upload</button>
      </form>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Saved receipts</h2>
        {!list.data.receipts.length ? <p>No receipt has been uploaded.</p> : (
          <ul className="list">
            {list.data.receipts.map((receipt) => (
              <li key={receipt.attachmentId}>
                <button type="button" className="btn-quiet" onClick={() => setParams({ id: receipt.attachmentId })}>
                  {STATUS[receipt.status] ?? receipt.status} · {receipt.fields.merchant || "No merchant yet"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {result ? <Notice>{result}</Notice> : null}
      {detail && selected ? (
        <div className="grid two" style={{ marginTop: 16 }}>
          <article className="card">
            <p className="kicker">{STATUS[detail.draft.status] ?? detail.draft.status}{busy ? ` · ${busy}` : ""}</p>
            {preview?.type.includes("pdf") ? <iframe className="receipt-preview" title="Receipt preview" src={preview.url} /> : preview ? <img className="receipt-preview" alt="Receipt preview" src={preview.url} /> : <p>Loading the preview…</p>}
            <p className="muted">{detail.draft.engine ? `Read by ${detail.draft.engine}.` : "Not read yet."} {detail.draft.confidence == null ? detail.draft.confidenceNote ?? "No confidence score was reported." : `Mean word confidence ${detail.draft.confidence}. ${detail.draft.confidenceNote ?? ""}`} The confidence score is an engine measurement. It does not prove the total or the category allocation.</p>
            {detail.draft.error ? <Notice kind="bad">{detail.draft.error} You can type the fields below. Missing lines do not block a manual receipt.</Notice> : null}
            {detail.possibleDuplicates.length ? <p>Possible duplicate file: {detail.possibleDuplicates.map((item) => item.attachmentId).join(", ")}. Nothing was merged.</p> : null}
            {detail.draft.fields.extractedLines?.length ? (
              <details>
                <summary>Original extraction</summary>
                <ul>{detail.draft.fields.extractedLines.map((line) => <li key={line.id ?? line.description}>{line.description} {line.amountMinor == null ? "unresolved" : <Money minor={line.amountMinor} />}</li>)}</ul>
              </details>
            ) : null}
            {detail.draft.rawText ? <details><summary>Text the reader returned</summary><pre>{detail.draft.rawText}</pre></details> : null}
          </article>
          <form className="card" onSubmit={(event) => event.preventDefault()}>
            <h2>Review</h2>
            {fields?.dateUnresolved && !date ? <p>{fields.dateUnresolved}</p> : null}
            {fields?.currencyUnresolved && !currency ? <p>{fields.currencyUnresolved}</p> : null}
            {fields?.totalUnresolved && !total ? <p>{fields.totalUnresolved}</p> : null}
            <Field label="Merchant"><input value={merchant} onChange={(event) => { setProposal(null); setMerchant(event.target.value); }} /></Field>
            <Field label="Receipt date"><input type="date" value={date} onChange={(event) => { setProposal(null); setDate(event.target.value); }} /></Field>
            <Field label="Currency"><input value={currency} onChange={(event) => { setProposal(null); setCurrency(event.target.value.toUpperCase()); }} placeholder="Unresolved" maxLength={3} /></Field>
            <Field label="Subtotal"><input inputMode="decimal" value={subtotal} onChange={(event) => { setProposal(null); setSubtotal(event.target.value); }} /></Field>
            <Field label="Tax"><input inputMode="decimal" value={tax} onChange={(event) => { setProposal(null); setTax(event.target.value); }} /></Field>
            <Field label="Tip"><input inputMode="decimal" value={tip} onChange={(event) => { setProposal(null); setTip(event.target.value); }} /></Field>
            <Field label="Discount"><input inputMode="decimal" value={discount} onChange={(event) => { setProposal(null); setDiscount(event.target.value); }} /></Field>
            <Field label="Other charges"><input inputMode="decimal" value={otherCharges} onChange={(event) => { setProposal(null); setOtherCharges(event.target.value); }} /></Field>
            <Field label="Total"><input inputMode="decimal" value={total} onChange={(event) => { setProposal(null); setTotal(event.target.value); }} /></Field>
            <label><input type="checkbox" checked={taxInclusive} onChange={(event) => { setProposal(null); setTaxInclusive(event.target.checked); }} /> Tax is already included in the item prices.</label>
            <fieldset>
              <legend>Line items</legend>
              {lines.map((line, index) => (
                <div className="receipt-line" key={line.id}>
                  <input aria-label="Item" value={line.description} onChange={(event) => updateLine(index, { description: event.target.value })} />
                  <input aria-label="Quantity" inputMode="decimal" placeholder="Qty" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} />
                  <input aria-label="Unit price" inputMode="decimal" placeholder="Price" value={line.unit} onChange={(event) => updateLine(index, { unit: event.target.value })} />
                  <input aria-label="Line amount" inputMode="decimal" placeholder="Amount" value={line.amount} onChange={(event) => updateLine(index, { amount: event.target.value })} />
                  <select aria-label="Line category" value={line.bucketId} onChange={(event) => updateLine(index, { bucketId: event.target.value })}>
                    <option value="">Category</option>
                    {categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <button type="button" className="btn-quiet" onClick={() => { setProposal(null); setLines(lines.filter((_, lineIndex) => lineIndex !== index)); }}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn-secondary" onClick={() => { setProposal(null); setLines([...lines, { id: `m${lines.length + 1}${crypto.randomUUID().slice(0, 4)}`, description: "", quantity: "", unit: "", amount: "", bucketId: "" }]); }}>Add line</button>
            </fieldset>
            {lineSubtotals.size ? (
              <ul>
                {[...lineSubtotals.entries()].map(([id, amount]) => <li key={id}>{categoryName(id)} lines: <Money minor={amount} /></li>)}
              </ul>
            ) : null}
            {fields?.lineVersusTotal === "differs" ? <p>Line items add to <Money minor={fields.lineSumMinor ?? 0} /> and the receipt total is <Money minor={fields.totalMinor ?? 0} />. Tax, tip, discount, and other charges are allocated only after you preview them.</p> : null}
            <fieldset>
              <legend>How to allocate tax, tip, discount, and other charges</legend>
              <label><input type="radio" name="allocation" checked={allocationMode === "proportional"} onChange={() => { setProposal(null); setAllocationMode("proportional"); }} /> Share them across the positive items.</label>
              <label><input type="radio" name="allocation" checked={allocationMode === "category"} onChange={() => { setProposal(null); setAllocationMode("category"); }} /> Put them on one category.</label>
              {allocationMode === "category" ? (
                <Field label="Adjustment category"><select value={allocationBucketId} onChange={(event) => { setProposal(null); setAllocationBucketId(event.target.value); }}><option value="">Choose a category</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
              ) : null}
            </fieldset>
            <Field label="Reviewed adjustment"><input inputMode="decimal" value={adjustmentAmount} onChange={(event) => { setProposal(null); setAdjustmentAmount(event.target.value); }} placeholder="Only if the total still differs" /></Field>
            <Field label="Adjustment category"><select value={adjustmentBucketId} onChange={(event) => { setProposal(null); setAdjustmentBucketId(event.target.value); }}><option value="">Choose a category</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <Field label="Why this adjustment"><input value={adjustmentNote} onChange={(event) => { setProposal(null); setAdjustmentNote(event.target.value); }} /></Field>
            {proposal ? (
              <div>
                <p>{proposal.message}</p>
                {proposal.categoryTotals.map((row) => <p key={row.bucketId}>{categoryName(row.bucketId)}: <Money minor={row.amountMinor} /></p>)}
                <p>{proposal.reconciled ? "The categories add up to the receipt total." : `The difference is ${proposal.differenceMinor} minor units. Nothing has been posted.`}</p>
              </div>
            ) : null}
            <div className="row">
              <button type="button" className="btn-secondary" disabled={!!busy || detail.draft.status === "confirmed" || detail.draft.status === "discarded"} onClick={() => run("Processing", async () => {
                const response = await api<{ kept?: boolean; reason?: string; draft: Draft }>(scoped(session.householdId, `/attachments/${selected}/extract`), { method: "POST", body: JSON.stringify({ version: detail.draft.version }) });
                if (response.kept) setResult(response.reason ?? "The current review was kept.");
                session.bump();
                await openReceipt(selected);
              })}>{detail.draft.status === "failed" ? "Try reading again" : "Read the receipt"}</button>
              <button type="button" className="btn" disabled={!!busy || detail.draft.status === "confirmed" || detail.draft.status === "discarded"} onClick={() => run("Saving", async () => {
                await saveDraft();
                setResult("Corrections saved. Cash and Ready to Assign were not changed.");
              })}>Save corrections</button>
              <button type="button" className="btn-secondary" disabled={!!busy || detail.draft.status === "confirmed" || detail.draft.status === "discarded"} onClick={() => run("Previewing", async () => {
                await saveDraft();
                const response = await api<{ proposal: Proposal | null; message?: string }>(scoped(session.householdId, `/attachments/${selected}/preview`), { method: "POST", body: "{}" });
                if (!response.proposal) throw new Error(response.message ?? "Assign a category to every line before previewing the allocation.");
                setProposal(response.proposal);
                setResult("This is the proposed allocation. Cash was not changed.");
              })}>Preview allocation</button>
            </div>
            <h2>Before confirming</h2>
            <Field label="Account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Choose an account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field>
            <Field label="One category for the whole receipt"><select value={bucketId} onChange={(event) => setBucketId(event.target.value)}><option value="">Use the line categories instead</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <ul>
              <li>Account: {account?.name ?? "Not selected"}</li>
              <li>Whole-receipt category: {categories.find((item) => item.id === bucketId)?.name ?? "Not used"}</li>
              <li>Merchant: {merchant || "Unresolved"}</li>
              <li>Date: {date || "Unresolved"}</li>
              <li>Currency: {currency || "Unresolved"}</li>
              <li>Total: {total || "Unresolved"}</li>
            </ul>
            {!categorized && lineMismatch ? <label><input type="checkbox" checked={acceptLine} onChange={(event) => setAcceptLine(event.target.checked)} /> The line items do not match the receipt. Continue with one category anyway.</label> : null}
            {currencyMismatch ? <label><input type="checkbox" checked={acceptCurrency} onChange={(event) => setAcceptCurrency(event.target.checked)} /> The receipt currency does not match the account. No conversion will be applied.</label> : null}
            <button type="button" className="btn" disabled={!!busy || !accountId || detail.draft.status === "confirmed" || (categorized ? !proposal?.reconciled : !bucketId)} onClick={() => run("Confirming", async () => {
              const current = categorized ? detail : await saveDraft();
              const version = current?.draft.version ?? detail.draft.version;
              const response = await api<{ created: boolean; duplicate: boolean; transactionId: string }>(scoped(session.householdId, `/attachments/${selected}/confirm`), { method: "POST", body: JSON.stringify({
                confirm: true, version, opId, accountId, acceptLineMismatch: categorized ? false : acceptLine, acceptCurrencyMismatch: acceptCurrency,
                splits: categorized ? [] : [{ bucketId, amountMinor: parseAmount(total, code) }],
              }) });
              setResult(response.created ? "Created one expense." : "This receipt was already confirmed. No second expense was created.");
              session.bump();
              await openReceipt(selected);
            })}>Create this expense</button>
            <h2>Possible matching transactions</h2>
            {!detail.possibleTransactions.length ? <p>No visible expense looks close. Linking is your decision.</p> : detail.possibleTransactions.map((txn) => (
              <article key={txn.id}>
                <p>{txn.date} {txn.payee} <Money minor={txn.amountMinor} currency={txn.currency} /> · version {txn.version} · {txn.reason}{txn.reconciled ? " Reconciled." : ""}</p>
                {fields?.totalMinor != null && fields.totalMinor !== Math.abs(txn.amountMinor) ? <p>The receipt total does not match this transaction. Linking keeps the amount unless you authorize a replacement.</p> : null}
                {fields?.date && fields.date !== txn.date ? <p>The receipt date does not match this transaction date.</p> : null}
                <label><input type="checkbox" checked={acceptTotal} onChange={(event) => setAcceptTotal(event.target.checked)} /> Link even if the total differs.</label>
                <label><input type="checkbox" checked={acceptDate} onChange={(event) => setAcceptDate(event.target.checked)} /> Link even if the date differs.</label>
                <label><input type="checkbox" checked={replaceSplits} onChange={(event) => setReplaceSplits(event.target.checked)} /> Replace this expense's categories with the reviewed lines.</label>
                <div className="row">
                  <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run("Previewing", async () => {
                    const response = await api<{ note: string; currentSplits: { bucketId: string | null; amountMinor: number; role: string }[]; proposedSplits: { bucketId: string; amountMinor: number; role: string }[]; currentAmountMinor: number; proposedAmountMinor: number }>(scoped(session.householdId, `/attachments/${selected}/apply`), { method: "POST", body: JSON.stringify({
                      confirm: true, preview: true, transactionId: txn.id, draftVersion: detail.draft.version, transactionVersion: txn.version, opId, replaceSplits,
                    }) });
                    const current = response.currentSplits.map((split) => `${categoryName(split.bucketId ?? "")} ${split.role} ${split.amountMinor}`).join(", ") || "none";
                    const next = response.proposedSplits.map((split) => `${categoryName(split.bucketId)} ${split.role} ${split.amountMinor}`).join(", ");
                    setLinkPreview(`Current version ${txn.version}: ${current}. Proposed: ${next}. Amount ${response.currentAmountMinor} to ${response.proposedAmountMinor}. ${response.note}`);
                  })}>Preview changes</button>
                  <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run("Linking", async () => {
                    const response = await api<{ created: boolean; note?: string; transactionId: string }>(scoped(session.householdId, `/attachments/${selected}/apply`), { method: "POST", body: JSON.stringify({
                      confirm: true, transactionId: txn.id, draftVersion: detail.draft.version, transactionVersion: txn.version, opId,
                      acceptTotalMismatch: acceptTotal, acceptDateMismatch: acceptDate, acceptCurrencyMismatch: acceptCurrency, acceptLineMismatch: acceptLine,
                      replaceSplits,
                    }) });
                    setResult(response.note ?? "The receipt was linked. No second expense was created.");
                    session.bump();
                    await openReceipt(selected);
                  })}>{replaceSplits ? "Replace categories" : "Link to this transaction"}</button>
                </div>
              </article>
            ))}
            {linkPreview ? <p>{linkPreview}</p> : null}
            {detail.draft.transactionId ? <p><Link to={`/activity?q=${encodeURIComponent(merchant)}`}>Open the linked transaction</Link></p> : null}
            <button type="button" className="btn-quiet" disabled={!!busy || detail.draft.status === "confirmed" || detail.draft.status === "discarded"} onClick={() => run("Discarding", async () => {
              await api(scoped(session.householdId, `/attachments/${selected}/discard`), { method: "POST", body: JSON.stringify({ version: detail.draft.version }) });
              setResult("The receipt was discarded. No transaction was changed.");
              session.bump();
              await openReceipt(selected);
            })}>Discard without financial changes</button>
          </form>
        </div>
      ) : null}
    </Page>
  );
}
