import { Link } from "react-router-dom";
import { useSession } from "../session.js";
import { DeleteAccount } from "./Tools.js";

export function PrivacyPolicy() {
  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Privacy</h1>
      <p className="lede">BudgetCents stores the household records you enter so the same plan is available on the web and in the Android app.</p>
      <h2>What is stored</h2>
      <ul>
        <li>Account email, display name, a password hash, and optional authenticator data.</li>
        <li>Session tokens and device labels you use to sign in.</li>
        <li>Household names, roles, invitations, and the financial records you add: accounts, transactions, categories, goals, bills, holdings, and notes.</li>
        <li>Receipt files you attach. The file is stored and can be read on the BudgetCents server with Tesseract. It is not sent to an external OCR service, and it does not become a transaction until you confirm it.</li>
      </ul>
      <h2>What is not connected</h2>
      <p>Bank aggregation, live market prices, credit monitoring, bill negotiation, subscription cancellation, tax filing, and estate-document services are not active. A screen that says a provider is not configured has not contacted that provider. Manual credit scores and manual prices stay labeled as entries you typed.</p>
      <h2>Who can see a record</h2>
      <p>Household members see shared spaces according to their role. A private account is left out of other members’ dashboards, exports, search, and assistant answers. The assistant answers from records the signed-in person is allowed to see.</p>
      <h2>Sharing and retention</h2>
      <p>BudgetCents does not sell personal information and does not use an advertising identifier. Production traffic should be served over HTTPS. You can export a backup from Settings and delete the user account there, or in the Android Security screen, after entering the password and the confirmation word.</p>
      <p><Link to="/delete-account">How to delete an account</Link> · <Link to="/login">Sign in</Link></p>
    </main>
  );
}

export function AccountDeletion() {
  const session = useSession();
  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Delete your account</h1>
      <p className="lede">Account deletion runs on the server after you confirm it. It is not a request form that someone else processes later.</p>
      <ul>
        <li>Your user, sessions, and unused verification or reset links are removed.</li>
        <li>A household you alone own is removed with its transactions and attachments.</li>
        <li>A household that still has other members stays until ownership is transferred.</li>
        <li>Households you do not own stay, including the other members’ records.</li>
      </ul>
      <p>Signing out, or deleting the app from a phone, does not delete the server account.</p>
      {session.user ? <DeleteAccount /> : <p><Link to="/login">Sign in to delete the account</Link></p>}
      <p><Link to="/privacy">Privacy</Link></p>
    </main>
  );
}
