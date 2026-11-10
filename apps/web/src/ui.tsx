import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { formatMoney } from "./format.js";
import { useSession } from "./session.js";

export function Page({ title, lede, actions, children }: { title: string; lede?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {lede ? <p className="lede">{lede}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <p className="state" role="status">{label}…</p>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner bad" role="alert">
      <p>{message}</p>
      {onRetry ? <button className="btn-secondary" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      {action}
    </div>
  );
}

export function Money({ minor, currency, tone = true }: { minor: number; currency?: string; tone?: boolean }) {
  const { user, currency: householdCurrency } = useSession();
  const hidden = user?.privacyMode ?? false;
  const code = currency || householdCurrency;
  const className = !tone || hidden ? "money" : minor < 0 ? "money neg" : minor > 0 ? "money pos" : "money";
  return <span className={className}>{formatMoney(minor, code, hidden)}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Notice({ children, kind = "ok" }: { children: ReactNode; kind?: "ok" | "bad" | "demo" }) {
  return <div className={`banner ${kind}`} role="status">{children}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-back" role="presentation" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn-quiet" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spark({ points, label }: { points: { date: string; balanceMinor: number }[]; label: string }) {
  if (points.length < 2) return <p className="muted">Add a few scheduled items to draw the projection.</p>;
  const values = points.map((point) => point.balanceMinor);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = Math.max(1, max - min);
  const width = 640;
  const height = 180;
  const path = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - ((point.balanceMinor - min) / span) * (height - 20) - 8;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const zero = height - ((0 - min) / span) * (height - 20) - 8;
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <line x1="0" x2={width} y1={zero} y2={zero} stroke="currentColor" strokeOpacity="0.25" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="3" />
      </svg>
      <details>
        <summary>Projection table</summary>
        <table>
          <thead><tr><th>Date</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {points.filter((_, index) => index % Math.ceil(points.length / 8) === 0 || index === points.length - 1).map((point) => (
              <tr key={point.date}><td>{point.date}</td><td className="num"><Money minor={point.balanceMinor} /></td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    loader()
      .then((data) => { if (live) setState({ loading: false, data }); })
      .catch((error: unknown) => { if (live) setState({ loading: false, error: error instanceof Error ? error.message : "Could not load." }); });
    return () => { live = false; };
  }, deps);
  return state;
}

export function useFormError() {
  const [error, setError] = useState("");
  async function run(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault();
    setError("");
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "That did not save."); }
  }
  return { error, run, setError };
}
