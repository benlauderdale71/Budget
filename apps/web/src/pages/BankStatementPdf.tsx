import { useState } from "react";
import { api } from "../api.js";
import { Field } from "../ui.js";

type Row = { page: number; source: string; date: string; payee: string; amount: string; issue: string };
type Draft = { rows: Row[]; warnings: string[]; pages: number };
const empty: Row = { page: 0, source: "Manually added", date: "", payee: "", amount: "", issue: "" };
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export function BankStatementPdf({
  url,
  accountId,
  onPreview,
  onEdit,
}: {
  url: string;
  accountId: string;
  onPreview: (csv: string) => Promise<void>;
  onEdit: () => void;
}) {
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [file, setFile] = useState<File>(),
    [draft, setDraft] = useState<Draft>();
  const [included, setIncluded] = useState<boolean[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function reset() {
    setDraft(undefined);
    setIncluded([]);
    setError("");
    onEdit();
  }
  async function read() {
    reset();
    setBusy(true);
    try {
      if (!file || file.size > 8_000_000) throw Error("Choose a PDF of up to 8 MB.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(Error("Could not open the file."));
        reader.readAsDataURL(file);
      });
      const next = await api<Draft>(url, {
        method: "POST",
        body: JSON.stringify({ accountId, year: Number(year), data }),
      });
      setDraft(next);
      setIncluded(next.rows.map((row) => !row.issue));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read PDF.");
    } finally {
      setBusy(false);
    }
  }
  function edit(index: number, key: "date" | "payee" | "amount", value: string) {
    onEdit();
    setDraft(
      (current) =>
        current && {
          ...current,
          rows: current.rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
        },
    );
  }
  const chosen = draft?.rows.filter((_, i) => included[i]) ?? [];
  async function preview() {
    setBusy(true);
    setError("");
    try {
      if (
        chosen.some(
          (r) =>
            !r.date ||
            !r.payee.trim() ||
            !/^[+-]?\d+(\.\d{1,2})?$/.test(r.amount.trim()) ||
            Number(r.amount) === 0,
        )
      )
        throw Error("Each included row needs a date, a payee and a signed, nonzero amount.");
      const rows = chosen.map((r) =>
        [r.date, r.payee, r.amount, "Statement " + (r.page ? "page " + r.page + ": " : "") + r.source]
          .map(quote)
          .join(","),
      );
      await onPreview(["Date,Payee,Amount,Notes", ...rows].join("\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not preview rows.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>Bank statement PDF</h3>
      <Field label="Year for dates without a printed year">
        <input
          type="number"
          min="1900"
          max="2200"
          value={year}
          onChange={(e) => {
            reset();
            setYear(e.target.value);
          }}
        />
      </Field>
      <Field label="Statement PDF">
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => {
            reset();
            setFile(e.target.files?.[0]);
          }}
        />
      </Field>
      <button type="button" disabled={busy || !accountId || !file} onClick={read}>
        {busy ? "Working…" : "Read statement"}
      </button>
      {draft && (
        <>
          <h4>Review the statement draft</h4>
          <p>
            {draft.pages} pages read. Compare the rows with your statement. Use a minus sign for money out.
            Choose the rows to check against your ledger.
          </p>
          {draft.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {["Include", "Original line", "Date", "Payee", "Signed amount"].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={"Include row " + (i + 1)}
                        checked={!!included[i]}
                        onChange={(e) => {
                          onEdit();
                          setIncluded(included.map((v, j) => (i === j ? e.target.checked : v)));
                        }}
                      />
                    </td>
                    <td>
                      {r.page > 0 && <strong>Page {r.page} · </strong>}
                      {r.source}
                      {r.issue && <p>{r.issue}</p>}
                    </td>
                    {(["date", "payee", "amount"] as const).map((k) => (
                      <td key={k}>
                        <input
                          aria-label={k + " row " + (i + 1)}
                          type={k === "date" ? "date" : "text"}
                          value={r[k]}
                          onChange={(e) => edit(i, k, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => {
              onEdit();
              setDraft({ ...draft, rows: [...draft.rows, { ...empty }] });
              setIncluded([...included, true]);
            }}
          >
            Add a missing row
          </button>
          <button type="button" disabled={busy || !chosen.length} onClick={preview}>
            Preview ledger matches ({chosen.length})
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
