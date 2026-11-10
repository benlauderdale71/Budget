import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useSession } from "./session.js";
import { Auth, Invite } from "./pages/Auth.js";
import { Home } from "./pages/Home.js";
import { Plan } from "./pages/Plan.js";
import { Activity } from "./pages/Activity.js";
import { Accounts } from "./pages/Accounts.js";
import { Bills, Debts, Forecast, Goals } from "./pages/Planning.js";
import { Investments, Reports, Retirement, Wealth } from "./pages/Wealth.js";
import { Assistant, Cases, Checklists, Credit, Household, ImportPage, Learn, More, Providers, Rules, Settings } from "./pages/Tools.js";
import { AccountDeletion, PrivacyPolicy } from "./pages/Legal.js";

const primary = [
  ["/", "Home"],
  ["/plan", "Plan"],
  ["/activity", "Activity"],
  ["/accounts", "Accounts"],
  ["/wealth", "Wealth"],
] as const;

const groups: { title: string; links: [string, string][] }[] = [
  { title: "Planning", links: [["/forecast", "Forecast"], ["/bills", "Bills"], ["/debts", "Debts"], ["/goals", "Goals"]] },
  { title: "Insight", links: [["/reports", "Reports"], ["/investments", "Investments"], ["/retirement", "Retirement"], ["/assistant", "Assistant"]] },
  { title: "Household", links: [["/household", "Sharing"], ["/rules", "Rules"], ["/import", "Import"], ["/providers", "Connections"], ["/cases", "Requests"], ["/credit", "Credit"], ["/learn", "Learn"], ["/checklists", "Checklists"], ["/settings", "Settings"]] },
];

function Shell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const navigate = useNavigate();
  if (!session.ready) return <p className="state">Opening BudgetCents…</p>;
  if (!session.user || !session.householdId) return <Navigate to="/login" replace />;
  const household = session.households.find((item) => item.id === session.householdId);
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="wordmark">Budget<i>Cents</i></div>
        <nav aria-label="Primary">
          {primary.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"} className="nav-link">{label}</NavLink>)}
          {groups.map((group) => (
            <div key={group.title}>
              <div className="nav-group">{group.title}</div>
              {group.links.map(([to, label]) => <NavLink key={to} to={to} className="nav-link">{label}</NavLink>)}
            </div>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <form className="row" role="search" onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            navigate(`/activity?q=${encodeURIComponent(String(data.get("q") ?? ""))}`);
          }}>
            <label className="sr" htmlFor="search">Search transactions</label>
            <input id="search" className="search" name="q" placeholder="Search payee or note" />
          </form>
          <div className="topbar-controls">
            <label className="sr" htmlFor="household">Household</label>
            <select id="household" value={session.householdId} onChange={(event) => session.chooseHousehold(event.target.value)}>
              {session.households.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button className="btn-secondary" onClick={() => session.patchMe({ privacyMode: !session.user?.privacyMode })}>
              {session.user.privacyMode ? "Show amounts" : "Hide amounts"}
            </button>
            <button className="btn-quiet" onClick={() => session.signOut()}>Sign out</button>
          </div>
        </header>
        <main id="main" className="content">
          {household && Number(household.is_demo) === 1 ? <div className="banner demo">Sample household. The people, balances, and prices are fictional and stay separate from a household you create.</div> : null}
          {session.offline ? <div className="banner bad" role="status">This browser is offline. You can still draft a transaction; it stays on the device until the connection returns.{session.queued ? ` ${session.queued} waiting.` : ""}</div> : null}
          {children}
        </main>
      </div>
      <nav className="tabbar" aria-label="Mobile">
        {([["/", "Home"], ["/plan", "Plan"], ["/activity", "Activity"], ["/wealth", "Wealth"]] as const).map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>)}
        <NavLink to="/more">More</NavLink>
      </nav>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Auth />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/delete-account" element={<AccountDeletion />} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="*" element={<Shell><Routes>
        <Route path="/" element={<Home />} />
        <Route path="/plan" element={<Plan />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/wealth" element={<Wealth />} />
        <Route path="/forecast" element={<Forecast />} />
        <Route path="/bills" element={<Bills />} />
        <Route path="/debts" element={<Debts />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/investments" element={<Investments />} />
        <Route path="/retirement" element={<Retirement />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/household" element={<Household />} />
        <Route path="/providers" element={<Providers />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/credit" element={<Credit />} />
        <Route path="/learn" element={<Learn />} />
        <Route path="/checklists" element={<Checklists />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/more" element={<More />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Shell>} />
    </Routes>
  );
}
