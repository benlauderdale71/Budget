import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { formatMoney, parseAmount } from "../format.js";
import { scoped, useSession } from "../session.js";
import { Field, Loading, Notice, Page } from "../ui.js";

interface SetupStep {
  id: string;
  title: string;
  optional: boolean;
  status: string;
}

interface SetupState {
  demo?: boolean;
  note?: string;
  version: number;
  step: string;
  finished: boolean;
  emailVerified: boolean;
  policy: string;
  steps: SetupStep[];
  draft: Record<string, unknown>;
  spaceId: string;
  buckets: { id: string; name: string; kind: string }[];
  review: {
    actualBalances: { id: string; name: string; kind: string; balanceMinor: number }[];
    expectedIncome: { id: string; name: string; amountMinor: number; note: string }[];
    allocations: { readyToAssignMinor: number; givenAJobMinor: number; note: string };
    notFinished: string[];
  };
}

const ORDER = ["who", "preferences", "verify", "accounts", "import", "categories", "income", "bills", "goal", "invite", "review"];
const KEYS: Record<string, string> = {
  accounts: "accountSetupKey",
  categories: "categorySetupKey",
  income: "incomeSetupKey",
  bills: "billSetupKey",
  goal: "goalSetupKey",
};
const COMPLETE: Record<string, string> = {
  account: "accounts",
  category: "categories",
  income: "income",
  bill: "bills",
  goal: "goal",
};

export function Setup() {
  const session = useSession();
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function load() {
    const next = await api<SetupState>(scoped(session.householdId, "/onboarding"));
    setSetup(next);
    return next;
  }

  useEffect(() => {
    let live = true;
    load().catch((caught: unknown) => {
      if (live) setError(caught instanceof Error ? caught.message : "Setup could not be loaded.");
    });
    return () => { live = false; };
  }, [session.householdId]);

  async function save(body: Record<string, unknown>, message?: string) {
    if (!setup || lock.current) return null;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await api<SetupState>(scoped(session.householdId, "/onboarding"), {
        method: "PATCH",
        body: JSON.stringify({ version: setup.version, ...body }),
      });
      setSetup(next);
      if (message) setStatus(message);
      await session.refresh();
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That setup change was not saved.");
      if (caught instanceof Error && caught.message.includes("Reload")) await load().catch(() => undefined);
      return null;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function ensureKey(current: SetupState, kind: string) {
    const name = KEYS[kind];
    const existing = current.draft[name];
    if (typeof existing === "string" && existing) return { state: current, key: existing };
    const key = crypto.randomUUID();
    const next = await api<SetupState>(scoped(session.householdId, "/onboarding"), {
      method: "PATCH",
      body: JSON.stringify({ version: current.version, draft: { [name]: key } }),
    });
    setSetup(next);
    return { state: next, key };
  }

  async function addResource(kind: string, payload: Record<string, unknown>, message: string) {
    if (!setup || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const ready = await ensureKey(setup, kind);
      const result = await api<{ duplicate: boolean; onboarding: SetupState }>(scoped(session.householdId, "/onboarding/resources"), {
        method: "POST",
        body: JSON.stringify({ version: ready.state.version, kind, setupKey: ready.key, payload }),
      });
      const rotated = crypto.randomUUID();
      const next = await api<SetupState>(scoped(session.householdId, "/onboarding"), {
        method: "PATCH",
        body: JSON.stringify({ version: result.onboarding.version, draft: { [KEYS[kind]]: rotated }, complete: COMPLETE[kind], step: COMPLETE[kind] }),
      });
      setSetup(next);
      setStatus(result.duplicate ? `${message} The earlier save was kept.` : message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That was not saved, and setup stayed on this step.");
      await load().catch(() => undefined);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  if (!setup) return error ? <Page title="Setup"><Notice kind="bad">{error}</Notice></Page> : <Loading />;
  if (setup.demo) {
    return (
      <Page title="Setup" lede={setup.note}>
        <p>The sample household stays separate from a household you create.</p>
        <Link to="/">Back to the sample household</Link>
      </Page>
    );
  }

  const step = setup.step;
  const index = ORDER.indexOf(step);
  const currency = session.currency || "USD";

  return (
    <Page title="Setup" lede="Manual setup works without a bank connection. Optional steps can be skipped and opened again.">
      <p>{setup.policy}</p>
      <div className="chips" role="list">
        {setup.steps.map((item) => (
          <button key={item.id} type="button" className="chip" aria-pressed={item.id === step} disabled={busy} onClick={() => void save({ step: item.id })}>
            {item.title}{item.status === "done" ? " · done" : item.status === "skipped" ? " · skipped" : ""}
          </button>
        ))}
      </div>
      {status ? <p role="status">{status}</p> : null}
      {error ? <Notice kind="bad">{error}</Notice> : null}
      {index > 0 ? <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ step: ORDER[index - 1] })}>Back</button> : null}

      {step === "who" ? (
        <section className="card">
          <h2>Who this plan is for</h2>
          <div className="chips">
            {([
              ["individual", "Individual"],
              ["couple", "Couple"],
              ["family", "Family"],
              ["freelancer", "Freelancer"],
              ["mixed", "Household and business"],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" className="chip" disabled={busy} onClick={() => void save({ who: { kind: id }, step: "preferences" }, `${label} saved.`)}>{label}</button>
            ))}
          </div>
        </section>
      ) : null}

      {step === "preferences" ? (
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void save({
            preferences: {
              householdName: String(data.get("householdName") ?? ""),
              currency: String(data.get("currency") ?? "USD"),
              locale: String(data.get("locale") ?? "en-US"),
              timeZone: String(data.get("timeZone") ?? "America/Chicago"),
              weekStart: Number(data.get("weekStart")),
              approach: String(data.get("approach") ?? "zero"),
            },
            step: "verify",
          }, "Preferences saved.");
        }}>
          <h2>Household preferences</h2>
          <p className="muted">Changing these preferences does not create income or change a balance.</p>
          <Field label="Household name"><input name="householdName" required defaultValue={text(setup.draft.preferences, "householdName") || session.households.find((item) => item.id === session.householdId)?.name || ""} /></Field>
          <Field label="Currency"><input name="currency" required maxLength={3} defaultValue={text(setup.draft.preferences, "currency") || currency} /></Field>
          <Field label="Locale"><input name="locale" required defaultValue={text(setup.draft.preferences, "locale") || session.user?.locale || "en-US"} /></Field>
          <Field label="Time zone"><input name="timeZone" required defaultValue={text(setup.draft.preferences, "timeZone") || session.user?.timeZone || "America/Chicago"} /></Field>
          <Field label="Week start">
            <select name="weekStart" defaultValue={text(setup.draft.preferences, "weekStart") || String(session.user?.weekStart ?? 0)}>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, value) => <option key={day} value={value}>{day}</option>)}
            </select>
          </Field>
          <Field label="Budget approach">
            <select name="approach" defaultValue={text(setup.draft.preferences, "approach") || session.user?.budgetApproach || "zero"}>
              <option value="zero">Zero-based</option>
              <option value="category">Categories</option>
              <option value="envelope">Envelopes</option>
              <option value="flex">Flex</option>
            </select>
          </Field>
          <button className="btn" type="submit" disabled={busy}>Save preferences</button>
        </form>
      ) : null}

      {step === "verify" ? (
        <section className="card">
          <h2>Email verification</h2>
          {setup.emailVerified ? <p role="status">Email verified.</p> : <p>Open the verification link, or paste its token. A development server keeps that message in the local outbox. SMTP delivery is not active.</p>}
          <p><Link to="/dev/mail">Development mail</Link></p>
          <button type="button" className="btn-secondary" disabled={busy || setup.emailVerified} onClick={() => {
            setError("");
            api<{ message: string }>("/api/auth/verify-email/resend", { method: "POST" })
              .then((result) => setStatus(result.message))
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "A new message was not created."));
          }}>Resend verification</button>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setBusy(true);
            api("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: String(data.get("token") ?? "") }) })
              .then(async () => {
                await session.refresh();
                await load();
                setStatus("Email verified.");
              })
              .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "That verification link did not work."))
              .finally(() => setBusy(false));
          }}>
            <Field label="Verification token"><input name="token" /></Field>
            <button className="btn" type="submit" disabled={busy}>Verify email</button>
          </form>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "verify", step: "accounts" })}>Continue without verifying</button>
        </section>
      ) : null}

      {step === "accounts" ? (
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const amount = String(data.get("opening") ?? "").trim();
          let openingBalanceMinor: number | undefined;
          try {
            if (amount) openingBalanceMinor = parseAmount(amount, currency);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Enter an amount.");
            return;
          }
          void addResource("account", {
            spaceId: setup.spaceId,
            name: String(data.get("name") ?? ""),
            kind: String(data.get("kind") ?? "checking"),
            openingBalanceMinor,
            openingDate: String(data.get("openingDate") ?? "") || undefined,
          }, "Account saved.");
        }}>
          <h2>Accounts and opening balances</h2>
          <p>Bank linking is not available. You can add accounts by hand and continue.</p>
          <Field label="Account name"><input name="name" required /></Field>
          <Field label="Kind">
            <select name="kind" defaultValue="checking">
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
              <option value="cash">Cash</option>
              <option value="credit">Credit card</option>
              <option value="loan">Loan</option>
            </select>
          </Field>
          <Field label="Opening balance"><input name="opening" inputMode="decimal" /></Field>
          <Field label="Opening date"><input name="openingDate" type="date" /></Field>
          <p className="muted">For a card or loan, enter what is owed. The opening balance is its own ledger entry. Leaving it blank adds the account with no balance.</p>
          <button className="btn" type="submit" disabled={busy}>Add account</button>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "accounts", step: "import" })}>Skip this step</button>
          <ul>{setup.review.actualBalances.map((account) => <li key={account.id}>{account.name} · {formatMoney(account.balanceMinor, currency)}</li>)}</ul>
        </form>
      ) : null}

      {step === "import" ? (
        <section className="card">
          <h2>Import</h2>
          <p>Bank linking is not available. You can continue. A file import is optional and stays on the import page.</p>
          <p><Link to="/import">Open import</Link></p>
          <button type="button" className="btn" disabled={busy} onClick={() => void save({ skip: "import", step: "categories" }, "Import skipped.")}>Skip this step</button>
        </section>
      ) : null}

      {step === "categories" ? (
        <section className="card">
          <h2>Categories and envelopes</h2>
          <p>The starter categories are the same records the plan uses. Using them does not assign money.</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void save({ complete: "categories", step: "income" }, "Starter categories kept.")}>Use the starter categories</button>
          <form onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void addResource("category", { spaceId: setup.spaceId, name: String(data.get("name") ?? ""), group: "Spending" }, "Category saved.");
          }}>
            <Field label="Category name"><input name="name" required /></Field>
            <button className="btn-secondary" type="submit" disabled={busy}>Add category</button>
          </form>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "categories", step: "income" })}>Skip this step</button>
        </section>
      ) : null}

      {step === "income" ? (
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const accountId = String(data.get("accountId") ?? "");
          if (!accountId) {
            setError("Add an account before expected income.");
            return;
          }
          let amountMinor = 0;
          try { amountMinor = parseAmount(String(data.get("amount") ?? ""), currency); } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Enter an amount.");
            return;
          }
          void addResource("income", {
            spaceId: setup.spaceId,
            accountId,
            name: String(data.get("name") ?? ""),
            kind: "salary",
            amountMinor,
            cadence: "monthly",
            startDate: String(data.get("startDate") ?? ""),
          }, "Expected income was saved.");
        }}>
          <h2>Expected income</h2>
          <p>This is a forecast. It does not add cash, Ready to Assign, or net worth.</p>
          <Field label="Income name"><input name="name" required /></Field>
          <Field label="Expected amount"><input name="amount" inputMode="decimal" required /></Field>
          <Field label="First date"><input name="startDate" type="date" required /></Field>
          <Field label="Deposit account">
            <select name="accountId" defaultValue={cashAccounts(setup)[0]?.id ?? ""}>
              {cashAccounts(setup).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </Field>
          {cashAccounts(setup).length === 0 ? <p>Add an account before expected income.</p> : null}
          <button className="btn" type="submit" disabled={busy}>Save expected income</button>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "income", step: "bills" })}>Skip this step</button>
        </form>
      ) : null}

      {step === "bills" ? (
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          let amountMinor = 0;
          try { amountMinor = parseAmount(String(data.get("amount") ?? ""), currency); } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Enter an amount.");
            return;
          }
          void addResource("bill", {
            spaceId: setup.spaceId,
            name: String(data.get("name") ?? ""),
            cadence: "monthly",
            nextDate: String(data.get("nextDate") ?? ""),
            amountMinor,
            direction: "outflow",
            type: "bill",
          }, "Bill saved.");
        }}>
          <h2>Bills</h2>
          <p>A bill is a schedule. It does not post a transaction.</p>
          <Field label="Bill name"><input name="name" required /></Field>
          <Field label="Bill amount"><input name="amount" inputMode="decimal" required /></Field>
          <Field label="Next date"><input name="nextDate" type="date" required /></Field>
          <button className="btn" type="submit" disabled={busy}>Save bill</button>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "bills", step: "goal" }, "Bills skipped.")}>Skip this step</button>
        </form>
      ) : null}

      {step === "goal" ? (
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const bucketId = String(data.get("bucketId") ?? "");
          if (!bucketId) {
            setError("Use a category before adding a goal.");
            return;
          }
          let targetMinor = 0;
          try { targetMinor = parseAmount(String(data.get("amount") ?? ""), currency); } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Enter an amount.");
            return;
          }
          void addResource("goal", {
            spaceId: setup.spaceId,
            bucketId,
            name: String(data.get("name") ?? ""),
            targetMinor,
            purpose: "goal",
          }, "Goal saved.");
        }}>
          <h2>A first goal</h2>
          <p>The goal uses an envelope that already exists. Saving it does not move money.</p>
          <Field label="Goal name"><input name="name" required /></Field>
          <Field label="Goal amount"><input name="amount" inputMode="decimal" required /></Field>
          <Field label="Envelope">
            <select name="bucketId" defaultValue={expenseBuckets(setup)[0]?.id ?? ""}>
              {expenseBuckets(setup).map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.name}</option>)}
            </select>
          </Field>
          <button className="btn" type="submit" disabled={busy}>Save goal</button>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "goal", step: "invite" }, "A first goal skipped.")}>Skip this step</button>
        </form>
      ) : null}

      {step === "invite" ? (
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          api<{ token: string; note?: string }>(scoped(session.householdId, "/invitations"), {
            method: "POST",
            body: JSON.stringify({ email: String(data.get("email") ?? ""), role: String(data.get("role") ?? "editor") }),
          }).then(async (result) => {
            setStatus(`${result.note ?? "Invitation link created."} ${window.location.origin}/invite/${result.token}`);
            await save({ complete: "invite" });
          }).catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : "The invitation was not created.");
          }).finally(() => setBusy(false));
        }}>
          <h2>Household invitations</h2>
          {setup.emailVerified ? <p>The invited person joins only if they sign in with this email. Creating a link does not send email.</p> : <p>Verify your email before inviting someone.</p>}
          <Field label="Invitation email"><input name="email" type="email" required /></Field>
          <Field label="Role"><select name="role" defaultValue="editor"><option value="editor">Editor</option><option value="contributor">Contributor</option><option value="readonly">Read-only</option><option value="admin">Admin</option><option value="coach">Coach</option><option value="planner">Planner</option><option value="accountant">Accountant</option></select></Field>
          <button className="btn" type="submit" disabled={busy}>Create invitation link</button>
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void save({ skip: "invite", step: "review" }, "Household invitations skipped.")}>Skip this step</button>
        </form>
      ) : null}

      {step === "review" ? (
        <section className="card">
          <h2>Review</h2>
          {setup.finished ? <p>Setup is finished. Optional steps can still be completed.</p> : null}
          <h3>Actual balances</h3>
          {setup.review.actualBalances.length === 0 ? <p>No opening balance has been entered.</p> : (
            <ul>{setup.review.actualBalances.map((account) => <li key={account.id}>{account.name} · {formatMoney(account.balanceMinor, currency)}</li>)}</ul>
          )}
          <h3>Expected future income</h3>
          {setup.review.expectedIncome.length === 0 ? <p>No expected income has been saved.</p> : (
            <ul>{setup.review.expectedIncome.map((item) => <li key={item.id}>{item.name} · {formatMoney(item.amountMinor, currency)}. {item.note}</li>)}</ul>
          )}
          <h3>Budget allocations</h3>
          <p>Ready to Assign {formatMoney(setup.review.allocations.readyToAssignMinor, currency)}. Already given a job {formatMoney(setup.review.allocations.givenAJobMinor, currency)}. {setup.review.allocations.note}</p>
          <h3>Not finished</h3>
          {setup.review.notFinished.length === 0 ? <p>Every optional step is either done or skipped, and the email is verified.</p> : <ul>{setup.review.notFinished.map((item) => <li key={item}>{item}</li>)}</ul>}
          {setup.finished ? <Link to="/">Enter BudgetCents</Link> : <button type="button" className="btn" disabled={busy} onClick={() => void save({ finish: true }, "Setup finished.")}>Finish setup</button>}
        </section>
      ) : null}
    </Page>
  );
}

function text(value: unknown, key: string) {
  if (!value || typeof value !== "object") return "";
  const found = (value as Record<string, unknown>)[key];
  return found == null ? "" : String(found);
}

function cashAccounts(setup: SetupState) {
  return setup.review.actualBalances.filter((account) => ["checking", "savings", "cash"].includes(account.kind));
}

function expenseBuckets(setup: SetupState) {
  return setup.buckets.filter((bucket) => bucket.kind === "expense");
}
