import { Link } from "react-router-dom";

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
        <li>Receipt files you attach. The file is stored. Optical character recognition is not connected, so the image is not turned into a transaction by itself.</li>
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
  return (
    <main className="content legal">
      <p className="kicker">BudgetCents</p>
      <h1>Delete your account</h1>
      <p className="lede">Account deletion is available after you sign in. It is not a request form that someone else processes later.</p>
      <ol>
        <li>Sign in on the web and open Settings, or open Security in the Android app.</li>
        <li>Enter your password and the confirmation word DELETE.</li>
        <li>The server removes the user. A household that you alone own is removed with it. A household that still has other members has to be left before that household is removed.</li>
      </ol>
      <p>Deleting the app from a phone signs that device out of its local session. It does not delete the server account.</p>
      <p><Link to="/login">Sign in to delete the account</Link> · <Link to="/privacy">Privacy</Link></p>
    </main>
  );
}
