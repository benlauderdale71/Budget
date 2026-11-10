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

export function SankeyChart({ links }: { links: { source: string; target: string; amountMinor: number }[] }) {
  const positive = links.filter((link) => link.amountMinor > 0);
  if (!positive.length) return <p className="muted">No inflow or spending in this period yet.</p>;
  const columnOf = (name: string) => (name === "Inflow" ? 1 : name === "Spending" ? 2 : positive.some((link) => link.source === "Spending" && link.target === name) ? 3 : 0);
  const names = [...new Set(positive.flatMap((link) => [link.source, link.target]))];
  const value = new Map<string, number>();
  for (const name of names) {
    const outbound = positive.filter((link) => link.source === name).reduce((sum, link) => sum + link.amountMinor, 0);
    const inbound = positive.filter((link) => link.target === name).reduce((sum, link) => sum + link.amountMinor, 0);
    value.set(name, Math.max(outbound, inbound, 1));
  }
  const width = 720;
  const height = Math.max(220, names.length * 36);
  const columns = [0, 1, 2, 3].map((column) => names.filter((name) => columnOf(name) === column));
  const pos = new Map<string, { x: number; y: number; h: number }>();
  columns.forEach((column, index) => {
    const total = column.reduce((sum, name) => sum + (value.get(name) ?? 0), 0) || 1;
    let y = 28;
    const usable = height - 36 - Math.max(0, column.length - 1) * 10;
    for (const name of column) {
      const h = Math.max(14, ((value.get(name) ?? 0) / total) * usable);
      pos.set(name, { x: 16 + index * (width / 4), y, h });
      y += h + 10;
    }
  });
  const outCursor = new Map<string, number>();
  const inCursor = new Map<string, number>();
  const paths = positive.flatMap((link) => {
    const source = pos.get(link.source);
    const target = pos.get(link.target);
    if (!source || !target) return [];
    const sourceHeight = Math.max(3, (link.amountMinor / (value.get(link.source) || 1)) * source.h);
    const targetHeight = Math.max(3, (link.amountMinor / (value.get(link.target) || 1)) * target.h);
    const sourceY = source.y + (outCursor.get(link.source) ?? 0);
    const targetY = target.y + (inCursor.get(link.target) ?? 0);
    outCursor.set(link.source, (outCursor.get(link.source) ?? 0) + sourceHeight);
    inCursor.set(link.target, (inCursor.get(link.target) ?? 0) + targetHeight);
    const x1 = source.x + 12;
    const x2 = target.x;
    const curve = (x1 + x2) / 2;
    const d = `M ${x1} ${sourceY} C ${curve} ${sourceY}, ${curve} ${targetY}, ${x2} ${targetY} L ${x2} ${targetY + targetHeight} C ${curve} ${targetY + targetHeight}, ${curve} ${sourceY + sourceHeight}, ${x1} ${sourceY + sourceHeight} Z`;
    return [{ d, label: `${link.source} to ${link.target}` }];
  });
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cash flow from income, through spending, into category groups">
        {paths.map((path) => <path key={path.d} d={path.d} fill="currentColor" opacity="0.28"><title>{path.label}</title></path>)}
        {[...pos.entries()].map(([name, box]) => (
          <g key={name}>
            <rect x={box.x} y={box.y} width={12} height={box.h} rx="3" fill="currentColor" />
            <text x={columnOf(name) === 3 ? box.x - 8 : box.x + 18} y={box.y + 12} fontSize="12" textAnchor={columnOf(name) === 3 ? "end" : "start"} fill="currentColor">{name}</text>
          </g>
        ))}
      </svg>
      <table>
        <thead><tr><th>From</th><th>To</th><th className="num">Amount</th></tr></thead>
        <tbody>{positive.map((link) => <tr key={`${link.source}-${link.target}`}><td>{link.source}</td><td>{link.target}</td><td className="num"><Money minor={link.amountMinor} /></td></tr>)}</tbody>
      </table>
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
