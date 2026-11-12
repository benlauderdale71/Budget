import { useRef, useState } from "react";
import { api } from "../api.js";
import { useSession } from "../session.js";
import { Notice } from "../ui.js";

export function LiveMessageTests() {
  const session = useSession(); const operations = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [note, setNote] = useState("");
  return <section className="card">
    <h2>Real message test</h2>
    <p>After saving consent, send a real test to your verified account email or to phones enrolled in the Android app. The provider must be configured. Acceptance does not prove delivery.</p>
    {(["email", "push"] as const).map((channel) => <button key={channel} type="button" className="btn-secondary" disabled={busy || session.offline} onClick={async () => {
      setBusy(true);
      operations.current[channel] ??= crypto.randomUUID();
      try {
        const result = await api<{ note: string }>("/api/notifications/send-test", { method: "POST", body: JSON.stringify({ channel, opId: operations.current[channel] }) });
        setNote(result.note); delete operations.current[channel];
      } catch (e) { setNote(e instanceof Error ? e.message : "The test could not be sent."); }
      finally { setBusy(false); }
    }}>{channel === "email" ? "Send to my verified email" : "Send to enrolled phones"}</button>)}
    {note && <Notice>{note}</Notice>}
  </section>;
}
