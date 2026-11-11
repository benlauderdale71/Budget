import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { minorToInput, parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import { ErrorNote, Field, Loading, Money, Notice, Page, useLoad } from "../ui.js";

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
  totalMinor: number | null;
  totalUnresolved: string | null;
  lineItems: { description: string; amountMinor: number | null; unresolved: string | null }[];
  lineSumMinor: number | null;
  lineVersusSubtotal: "matches" | "differs" | "incomplete";
  lineVersusTotal: "matches" | "differs" | "incomplete";
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
  const [total, setTotal] = useState("");
  const [lines, setLines] = useState<{ description: string; amount: string }[]>([]);
  const [accountId, setAccountId] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [opId, setOpId] = useState(() => crypto.randomUUID());
  const [acceptLine, setAcceptLine] = useState(false);
  const [acceptCurrency, setAcceptCurrency] = useState(false);
  const [acceptTotal, setAcceptTotal] = useState(false);
  const [acceptDate, setAcceptDate] = useState(false);

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
    setTotal(fields.totalMinor == null ? "" : minorToInput(fields.totalMinor));
    setLines(fields.lineItems.map((line) => ({ description: line.description, amount: line.amountMinor == null ? "" : minorToInput(line.amountMinor) })));
    setOpId(crypto.randomUUID());
    setAcceptLine(false);
    setAcceptCurrency(false);
    setAcceptTotal(false);
    setAcceptDate(false);
    const token = localStorage.getItem("budgetcents.token");
    const response = await fetch(scoped(session.householdId, `/attachments/${id}/file`), { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error("The receipt preview could not be opened.");
    const blob = await response.blob();
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return { url: URL.createObjectURL(blob), type: response.headers.get("content-type") ?? blob.type };
    });
  }

  useEffect(() => {
    if (!selected || !session.householdId) return;
    setResult("");
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

  function minorOrNull(text: string): number | null {
    return text.trim() ? parseAmount(text, currency || session.currency) : null;
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
            <p className="muted">{detail.draft.engine ? `Read by ${detail.draft.engine}.` : "Not read yet."} {detail.draft.confidence == null ? detail.draft.confidenceNote ?? "No confidence score was reported." : `Mean word confidence ${detail.draft.confidence}. ${detail.draft.confidenceNote ?? ""}`}</p>
            {detail.draft.error ? <Notice kind="bad">{detail.draft.error} You can type the fields below.</Notice> : null}
            {detail.possibleDuplicates.length ? <p>Possible duplicate file: {detail.possibleDuplicates.map((item) => item.attachmentId).join(", ")}. Nothing was merged.</p> : null}
            {detail.draft.rawText ? <details><summary>Text the reader returned</summary><pre>{detail.draft.rawText}</pre></details> : null}
          </article>
          <form className="card" onSubmit={(event) => event.preventDefault()}>
            <h2>Review</h2>
            {fields?.dateUnresolved && !date ? <p>{fields.dateUnresolved}</p> : null}
            {fields?.currencyUnresolved && !currency ? <p>{fields.currencyUnresolved}</p> : null}
            {fields?.totalUnresolved && !total ? <p>{fields.totalUnresolved}</p> : null}
            <Field label="Merchant"><input value={merchant} onChange={(event) => setMerchant(event.target.value)} /></Field>
            <Field label="Receipt date"><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
            <Field label="Currency"><input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="Unresolved" maxLength={3} /></Field>
            <Field label="Subtotal"><input inputMode="decimal" value={subtotal} onChange={(event) => setSubtotal(event.target.value)} /></Field>
            <Field label="Tax"><input inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} /></Field>
            <Field label="Tip"><input inputMode="decimal" value={tip} onChange={(event) => setTip(event.target.value)} /></Field>
            <Field label="Discount"><input inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value)} /></Field>
            <Field label="Total"><input inputMode="decimal" value={total} onChange={(event) => setTotal(event.target.value)} /></Field>
            <fieldset>
              <legend>Line items</legend>
              {lines.map((line, index) => (
                <div className="split-row" key={index}>
                  <input aria-label="Item" value={line.description} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} />
                  <input aria-label="Line amount" value={line.amount} onChange={(event) => setLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} />
                </div>
              ))}
              <button type="button" className="btn-secondary" onClick={() => setLines([...lines, { description: "", amount: "" }])}>Add line</button>
            </fieldset>
            {fields?.lineVersusTotal === "differs" ? <p>Line items add to <Money minor={fields.lineSumMinor ?? 0} /> and the receipt total is <Money minor={fields.totalMinor ?? 0} />.</p> : null}
            {fields?.lineVersusSubtotal === "differs" ? <p>Line items add to <Money minor={fields.lineSumMinor ?? 0} /> and the subtotal is <Money minor={fields.subtotalMinor ?? 0} />.</p> : null}
            <div className="row">
              <button type="button" className="btn-secondary" disabled={!!busy || detail.draft.status === "confirmed" || detail.draft.status === "discarded"} onClick={() => run(detail.draft.status === "uploaded" ? "Processing" : "Processing", async () => {
                const response = await api<{ kept?: boolean; reason?: string; draft: Draft }>(scoped(session.householdId, `/attachments/${selected}/extract`), { method: "POST", body: JSON.stringify({ version: detail.draft.version }) });
                if (response.kept) setResult(response.reason ?? "The current review was kept.");
                session.bump();
                await openReceipt(selected);
              })}>{detail.draft.status === "failed" ? "Try reading again" : "Read the receipt"}</button>
              <button type="button" className="btn" disabled={!!busy || detail.draft.status === "confirmed" || detail.draft.status === "discarded"} onClick={() => run("Saving", async () => {
                await api(scoped(session.householdId, `/attachments/${selected}/draft`), { method: "PATCH", body: JSON.stringify({
                  version: detail.draft.version,
                  fields: {
                    merchant: merchant || null, date: date || null, currency: currency || null,
                    subtotalMinor: minorOrNull(subtotal), taxMinor: minorOrNull(tax), tipMinor: minorOrNull(tip), discountMinor: minorOrNull(discount), totalMinor: minorOrNull(total),
                    lineItems: lines.filter((line) => line.description || line.amount).map((line) => ({ description: line.description, amountMinor: minorOrNull(line.amount) })),
                  },
                }) });
                setResult("Corrections saved. Cash and Ready to Assign were not changed.");
                session.bump();
                await openReceipt(selected);
              })}>Save corrections</button>
            </div>
            <h2>Before confirming</h2>
            <Field label="Account"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Choose an account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></Field>
            <Field label="Category"><select value={bucketId} onChange={(event) => setBucketId(event.target.value)}><option value="">Choose a category</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <ul>
              <li>Account: {account?.name ?? "Not selected"}</li>
              <li>Category: {categories.find((item) => item.id === bucketId)?.name ?? "Not selected"}</li>
              <li>Merchant: {merchant || "Unresolved"}</li>
              <li>Date: {date || "Unresolved"}</li>
              <li>Currency: {currency || "Unresolved"}</li>
              <li>Total: {total || "Unresolved"}</li>
            </ul>
            {lineMismatch ? <label><input type="checkbox" checked={acceptLine} onChange={(event) => setAcceptLine(event.target.checked)} /> The line items do not match the receipt. Continue anyway.</label> : null}
            {currencyMismatch ? <label><input type="checkbox" checked={acceptCurrency} onChange={(event) => setAcceptCurrency(event.target.checked)} /> The receipt currency does not match the account. No conversion will be applied.</label> : null}
            <button type="button" className="btn" disabled={!!busy || !accountId || !bucketId || detail.draft.status === "confirmed"} onClick={() => run("Confirming", async () => {
              const response = await api<{ created: boolean; duplicate: boolean; transactionId: string }>(scoped(session.householdId, `/attachments/${selected}/confirm`), { method: "POST", body: JSON.stringify({
                confirm: true, version: detail.draft.version, opId, accountId, acceptLineMismatch: acceptLine, acceptCurrencyMismatch: acceptCurrency,
                splits: [{ bucketId, amountMinor: parseAmount(total, currency || session.currency) }],
              }) });
              setResult(response.created ? "Created one expense." : "This receipt was already confirmed. No second expense was created.");
              session.bump();
              await openReceipt(selected);
            })}>Create this expense</button>
            <h2>Possible matching transactions</h2>
            {!detail.possibleTransactions.length ? <p>No visible expense looks close. Linking is your decision.</p> : detail.possibleTransactions.map((txn) => (
              <article key={txn.id}>
                <p>{txn.date} {txn.payee} <Money minor={txn.amountMinor} currency={txn.currency} /> · {txn.reason}{txn.reconciled ? " Reconciled." : ""}</p>
                {fields?.totalMinor != null && fields.totalMinor !== Math.abs(txn.amountMinor) ? <p>The receipt total does not match this transaction. It will not be overwritten.</p> : null}
                {fields?.date && fields.date !== txn.date ? <p>The receipt date does not match this transaction date.</p> : null}
                <label><input type="checkbox" checked={acceptTotal} onChange={(event) => setAcceptTotal(event.target.checked)} /> Link even if the total differs.</label>
                <label><input type="checkbox" checked={acceptDate} onChange={(event) => setAcceptDate(event.target.checked)} /> Link even if the date differs.</label>
                <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => run("Linking", async () => {
                  const response = await api<{ created: boolean; note?: string; transactionId: string }>(scoped(session.householdId, `/attachments/${selected}/apply`), { method: "POST", body: JSON.stringify({
                    confirm: true, transactionId: txn.id, draftVersion: detail.draft.version, transactionVersion: txn.version, opId,
                    acceptTotalMismatch: acceptTotal, acceptDateMismatch: acceptDate, acceptCurrencyMismatch: acceptCurrency, acceptLineMismatch: acceptLine,
                  }) });
                  setResult(response.note ?? "The receipt was linked. No second expense was created.");
                  session.bump();
                  await openReceipt(selected);
                })}>Link to this transaction</button>
              </article>
            ))}
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
