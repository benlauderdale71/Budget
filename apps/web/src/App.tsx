import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { mobileTabs, suiteGroups } from "./suite-navigation.js";
import { SuiteIcon } from "./SuiteIcon.js";
import { api } from "./api.js";
import { isDeviceSuite, openDeviceMarkets } from "./device-suite.js";
import { useAccess, useSession } from "./session.js";
import { DevMail, ResetPassword, VerifyEmail } from "./pages/AccountAccess.js";
import { Auth } from "./pages/Auth.js";
import { AndroidSignIn } from "./pages/AndroidSignIn.js";
import { Invite } from "./pages/Invite.js";
import { Setup } from "./pages/Setup.js";
import { Alerts } from "./pages/Alerts.js";
import { Home } from "./pages/Home.js";
import { Plan } from "./pages/Plan.js";
import { Activity } from "./pages/Activity.js";
import { Accounts } from "./pages/Accounts.js";
import { Bills, Debts, Forecast, Goals } from "./pages/Planning.js";
import { BillImport } from "./pages/BillImport.js";
import { PhysicalAssets } from "./pages/PhysicalAssets.js";
import { StatementCoverage } from "./pages/StatementCoverage.js";
import { CatchUp } from "./pages/CatchUp.js";
import { SpendingReport } from "./pages/SpendingReport.js";
import { CalendarPage, Paychecks } from "./pages/Paychecks.js";
import { Receipts } from "./pages/Receipts.js";
import { Investments, Reports, Retirement, Wealth } from "./pages/Wealth.js";
import { Assistant, Cases, Checklists, Credit, HelpCenter, Household, ImportPage, Learn, More, Providers, Rules, Settings } from "./pages/Tools.js";
import { AccountDeletion, PrivacyPolicy } from "./pages/Legal.js";

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

const ROLE_LABEL: Record<string, string> = {
  readonly: "Read-only",
  coach: "Coach",
  planner: "Planner",
  accountant: "Accountant",
};

function Shell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const access = useAccess();
  const navigate = useNavigate();
  const [accountOpen,setAccountOpen]=useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallPrompt);
    };
    const onInstalled = () => { setInstall(null); setStandalone(true); };
    const display = window.matchMedia("(display-mode: standalone)");
    setStandalone(display.matches);
    window.addEventListener("budgetcents-update", onUpdate);
    window.addEventListener("beforeinstallprompt", onInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("budgetcents-update", onUpdate);
      window.removeEventListener("beforeinstallprompt", onInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const [marketError,setMarketError]=useState("");
  useEffect(()=>{
    if(!isDeviceSuite())return;
    let opening=false;
    function marketClick(event:MouseEvent) {
      const link=event.target instanceof Element?event.target.closest("a[href]"):null;
      if(!(link instanceof HTMLAnchorElement))return;
      const url=new URL(link.href);
      if(url.origin!==location.origin || !/^\/stocks-crypto(?:\/|$)/.test(url.pathname))return;
      event.preventDefault();event.stopPropagation();
      if(opening)return;
      opening=true;setMarketError("");
      void api("/api/auth/market-session",{method:"POST"},{queue:false})
        .then(()=>openDeviceMarkets(url.pathname+url.search+url.hash))
        .catch(()=>setMarketError("Stocks & Crypto could not connect. Try opening Markets again."))
        .finally(()=>{opening=false;});
    }
    document.addEventListener("click",marketClick,true);
    return ()=>document.removeEventListener("click",marketClick,true);
  },[]);
  if (!session.ready) return <p className="state">Opening Budget HQ PRO…</p>;
  if (!session.user || !session.householdId) return <Navigate to="/login" replace />;
  const household = session.households.find((item) => item.id === session.householdId);
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="wordmark">Budget <i>HQ</i> PRO</div>
        <nav aria-label="Primary">
          {suiteGroups.map(group=><div key={group.name}><div className="nav-group">{group.name}</div>
            {group.tools.map(([to,label])=><NavLink className="nav-link" key={to} to={to} end={to==="/"} reloadDocument={to==="/stocks-crypto/"}>{label}</NavLink>)}</div>)}
          <NavLink className="nav-link" to="/more">All tools</NavLink>
        </nav>
      </aside>
      <div className="main">
        <header className="mobile-mast">
          <NavLink to="/" className="mobile-brand" aria-label="Budget HQ Pro home"><img src="/icon-192.png" width="36" height="36" alt=""/><span><b>Budget HQ Pro</b><small>{household?.name}</small></span></NavLink>
          <button type="button" className="mobile-account" aria-expanded={accountOpen} aria-controls="budget-account-controls" aria-label="Account and search" onClick={()=>setAccountOpen(!accountOpen)}><SuiteIcon name="Account"/></button>
        </header>
        <header id="budget-account-controls" className={`topbar ${accountOpen?"mobile-open":""}`}>
          <form className="row" role="search" onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setAccountOpen(false);
            navigate(`/activity?q=${encodeURIComponent(String(data.get("q") ?? ""))}`);
          }}>
            <label className="sr" htmlFor="search">Search transactions</label>
            <input id="search" className="search" name="q" placeholder="Search payee or note" />
            <button className="btn-secondary" type="submit">Search</button>
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
        <main id="main" className="content" tabIndex={-1}>
          {household && Number(household.is_demo) === 1 ? <div className="banner demo">Sample household. The people, balances, and prices are fictional and stay separate from a household you create.</div> : null}
          {access.readOnly ? <div className="banner" role="status">{ROLE_LABEL[access.role] ?? "Read-only"} access can view shared accounts and the plan. Private accounts stay with their owner. {access.canReview ? "You can comment and mark a shared transaction for review. That does not change the amount, category, or balance." : "You can comment on a shared transaction. A comment does not change the amount, category, or balance."} Saving, importing, and deleting stay with an owner, admin, editor, or contributor.</div> : null}
          {session.incoming ? <div className="banner" role="status">{session.incoming} <button className="btn-secondary" type="button" onClick={() => session.acceptIncoming()}>Reload</button></div> : null}
          {session.offline ? <div className="banner bad" role="status">This browser is offline. A waiting transaction or assignment is not saved until the server accepts it. Figures from the last open session are not the current ledger.{session.queued ? ` ${session.queued} waiting.` : ""}</div> : null}
          {session.syncError ? <div className="banner bad" role="alert">{session.syncError}</div> : null}
          {updateReady ? <div className="banner" role="status">A new version is ready. Unsent transactions stay on this device. <button className="btn-secondary" type="button" onClick={() => {
            sessionStorage.setItem("budgetcents.reload", "1");
            navigator.serviceWorker.getRegistration().then((registration) => registration?.waiting?.postMessage("skip-waiting"));
          }}>Reload to update</button></div> : null}
          {!isDeviceSuite() && !standalone && install ? <div className="banner" role="status">Install Budget HQ PRO on this device. It opens in its own window. The installed copy still needs a completed online load before it can start offline. <button className="btn-secondary" type="button" onClick={() => { void install.prompt(); setInstall(null); }}>Install</button></div> : null}
          {marketError && <p className="banner bad" role="alert">{marketError}</p>}
          {children}
        </main>
      </div>
      <nav className="tabbar" aria-label="Mobile">
        {mobileTabs.map(([to,label])=><NavLink key={to} to={to} end={to==="/"} reloadDocument={to==="/stocks-crypto/"}><SuiteIcon name={label}/><span>{label}</span></NavLink>)}
      </nav>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Auth />} />
      <Route path="/android/sign-in" element={<AndroidSignIn />} />
      <Route path="/verify" element={<VerifyEmail />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/dev/mail" element={<DevMail />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/delete-account" element={<AccountDeletion />} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="*" element={<Shell><Routes>
        <Route path="/" element={<Home />} />
        <Route path="/plan" element={<Plan />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/wealth" element={<Wealth />} />
        <Route path="/physical-assets" element={<PhysicalAssets />} />
        <Route path="/statement-coverage" element={<StatementCoverage/>}/>
        <Route path="/catch-up" element={<CatchUp/>}/>
        <Route path="/forecast" element={<Forecast />} />
        <Route path="/receipts" element={<Receipts />} />
        <Route path="/paychecks" element={<Paychecks />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/bills" element={<Bills />} />
        <Route path="/bills/import" element={<BillImport />} />
        <Route path="/debts" element={<Debts />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/spending" element={<SpendingReport />} />
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
        <Route path="/help" element={<HelpCenter />} />
        <Route path="/checklists" element={<Checklists />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/more" element={<More />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Shell>} />
    </Routes>
  );
}

