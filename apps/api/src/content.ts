export interface Lesson {
  id: string;
  title: string;
  topic: string;
  minutes: number;
  body: string;
  quiz: { question: string; choices: string[]; answer: number; explanation: string }[];
}

/** Original lessons. These are not copied from any reference app's courses. */
export const LESSONS: Lesson[] = [
  {
    id: "zero-based",
    title: "Give every dollar a job",
    topic: "Zero-based budgeting",
    minutes: 6,
    body: "Ready to Assign is cash that has already arrived and has not been given a job. Expected pay is not part of it. When you assign money, you are dividing that cash among categories. If Ready to Assign is negative, the plan is promising more than the cash on hand.",
    quiz: [{
      question: "A paycheck scheduled for Friday is shown on the calendar. Does it increase Ready to Assign today?",
      choices: ["Yes, if you trust it will arrive", "No. It stays in the forecast until it is received", "Only if the amount is the same as last time"],
      answer: 1,
      explanation: "Funded cash and a forecast are different. The calendar can show the paycheck without treating it as money you can assign.",
    }],
  },
  {
    id: "envelopes",
    title: "Envelopes are jobs, not bank accounts",
    topic: "Envelopes",
    minutes: 5,
    body: "An envelope answers what the money is for. The account answers where it sits. Moving money between envelopes does not move it between banks. A fill template remembers how you split a paycheck so the next one starts from the same plan.",
    quiz: [{
      question: "You move $40 from Groceries to Transport. What happens at the bank?",
      choices: ["A $40 transfer is sent", "Nothing at the bank. Only the job of that $40 changes", "The grocery store is notified"],
      answer: 1,
      explanation: "Allocation changes stay inside the plan until you actually spend or transfer.",
    }],
  },
  {
    id: "cards",
    title: "A card purchase is not spent twice",
    topic: "Credit cards",
    minutes: 7,
    body: "When a funded category pays with a card, that cash moves to the card payment reserve. Paying the card is a transfer of the reserve, not a new grocery trip. A refund lowers spending. It is not new income. If the purchase was never funded, the card balance grows and the cash plan does not pretend the money is still available.",
    quiz: [{
      question: "You buy $60 of groceries and $40 of household goods on a card, then pay the card $100. How much spending should reports show?",
      choices: ["$200", "$100", "$0 because the payment cancelled it"],
      answer: 1,
      explanation: "The purchase is the spending. The payment moves cash to the card.",
    }],
  },
  {
    id: "debt",
    title: "Snowball and avalanche",
    topic: "Debt",
    minutes: 6,
    body: "Both methods pay the minimum on every debt. Snowball aims extra dollars at the smallest balance. Avalanche aims them at the highest interest rate. The planner shows interest and time under the assumptions on screen. It is a model, not a lender's payoff quote.",
    quiz: [{
      question: "Which debt gets the extra payment in an avalanche plan?",
      choices: ["The smallest balance", "The highest APR", "The one due first"],
      answer: 1,
      explanation: "Avalanche sorts by interest rate. Snowball sorts by balance.",
    }],
  },
  {
    id: "emergency",
    title: "An emergency fund is one pile of cash",
    topic: "Savings",
    minutes: 4,
    body: "A target of three months of essential spending is a goal for a specific envelope. Those dollars cannot also be counted as safe to spend. The gap is the target minus what is already in the emergency envelope.",
    quiz: [{
      question: "Your checking account holds $1,000, of which $600 is in the emergency envelope. How much of that $600 is also safe to spend?",
      choices: ["$600", "$0", "$1,000"],
      answer: 1,
      explanation: "Reserved money stays reserved. Safe to spend is what is left after reserves.",
    }],
  },
  {
    id: "household",
    title: "Shared plans and private accounts",
    topic: "Household",
    minutes: 5,
    body: "A shared plan is visible to the people you invite, and the invitation says so before they accept. A private account stays out of their dashboards, exports, search, and assistant answers. Hiding a row on your own screen is not the same as a permission.",
    quiz: [{
      question: "You mark an account private. Can another household member download it in a backup?",
      choices: ["Yes, backups include everything", "No. The server leaves it out of their export", "Only if they are an accountant"],
      answer: 1,
      explanation: "Privacy is applied to exports and other outputs, not only to the account list.",
    }],
  },
];

export const PROVIDERS = [
  { id: "manual", name: "Manual and file import", group: "Accounts", status: "active", implementation: "ready", capabilities: ["Balances", "Transactions", "Holdings you type in"], needs: "None. You enter the records.", cost: "Included" },
  { id: "sandbox-bank", name: "Sandbox bank fixtures", group: "Accounts", status: "fixture", implementation: "fixture", capabilities: ["Built-in history", "Pending to posted", "Reconnect", "Revoke"], needs: "No bank is contacted. These rows are fixtures inside BudgetCents, not an aggregation provider.", cost: "Included" },
  { id: "aggregation", name: "Bank aggregation", group: "Accounts", status: "missing", implementation: "missing", capabilities: ["Authorized account linking", "Balances", "Posted and pending transactions"], needs: "No aggregation client is implemented. A client id would not import transactions. BudgetCents never asks for a bank password.", cost: "Provider pricing" },
  { id: "bills", name: "Bill data", group: "Bills", status: "missing", implementation: "missing", capabilities: ["Statement balance", "Minimum due", "Due date"], needs: "No bill-data client is implemented. A stored bill you type is not a biller feed.", cost: "Provider pricing" },
  { id: "market", name: "Market and fund data", group: "Investments", status: "missing", implementation: "missing", capabilities: ["Prices", "Classification", "Fund look-through where licensed"], needs: "No market-data client is implemented. A price you type stays manual.", cost: "License" },
  { id: "property", name: "Property valuation", group: "Net worth", status: "missing", implementation: "missing", capabilities: ["Estimate", "Dated history"], needs: "No valuation client is implemented.", cost: "Provider pricing" },
  { id: "vehicle", name: "Vehicle valuation", group: "Net worth", status: "missing", implementation: "missing", capabilities: ["Estimate"], needs: "No valuation client is implemented.", cost: "Provider pricing" },
  { id: "credit", name: "Credit reporting", group: "Credit", status: "missing", implementation: "missing", capabilities: ["Score", "Factors", "Report"], needs: "No bureau client is implemented. A score you type is not a credit report.", cost: "Provider pricing" },
  { id: "sms", name: "Text messaging", group: "Alerts", status: "test_sink", implementation: "test_sink", capabilities: ["Consent", "Opt-out", "Test-sink status"], needs: "No SMS client sends a message. The test sink can accept, queue, fail, or refuse. Accepted is not delivered.", cost: "Per message" },
  { id: "push", name: "Remote push", group: "Alerts", status: "test_sink", implementation: "test_sink", capabilities: ["Device token storage", "Test-sink status"], needs: "A token can be stored. No push provider sends it. The phone notification is local, not remote push.", cost: "Provider pricing" },
  { id: "savings", name: "Savings transfer partner", group: "Savings", status: "missing", implementation: "missing", capabilities: ["Scheduled transfers", "Status", "Reversals"], needs: "No transfer client is implemented. A goal does not hold deposits or pay interest.", cost: "Partner terms" },
  { id: "concierge", name: "Cancellation and negotiation", group: "Bills", status: "missing", implementation: "missing", capabilities: ["Authorization record"], needs: "Saving a request does not contact a biller. No concierge client is implemented.", cost: "Operator pricing" },
  { id: "coaching", name: "Human coaching", group: "Learning", status: "missing", implementation: "missing", capabilities: ["Scheduling handoff"], needs: "No coach is connected. Lessons are not an appointment.", cost: "Coach pricing" },
  { id: "tax", name: "Tax-filing handoff", group: "Business", status: "missing", implementation: "missing", capabilities: ["Document checklist", "Status"], needs: "No filing client is implemented. A set-aside is not a filed return.", cost: "Partner pricing" },
  { id: "estate", name: "Will and trust handoff", group: "Estate", status: "missing", implementation: "missing", capabilities: ["Eligibility", "Status"], needs: "No document client is implemented. A checklist is not an executed will.", cost: "Partner pricing" },
  { id: "smtp", name: "Email delivery", group: "Account", status: "local_outbox", implementation: "outbox", capabilities: ["Verification copy", "Password-reset copy"], needs: "Copies stay in the local outbox. Setting SMTP_URL does not send mail. This build has no SMTP client. Alert tests use the test sink, not this outbox.", cost: "Mail host" },
  { id: "model", name: "External language model", group: "Assistant", status: "missing", implementation: "missing", capabilities: ["Wording around ledger facts"], needs: "No model client is implemented. Amounts are still computed in BudgetCents, and the assistant answers without a model.", cost: "Model pricing" },
] as const;

export function providerCatalog() {
  return PROVIDERS.map((provider) => {
    if (provider.id === "aggregation") return { ...provider, name: "SimpleFIN bank history", status: /^[0-9a-f]{64}$/i.test(process.env.BUDGETCENTS_PROVIDER_KEY ?? "") ? "ready_to_connect" : "needs_configuration", implementation: "implemented", capabilities: ["Encrypted read-only connection", "Posted-history preview", "Selected imports with duplicate protection"], needs: "Enter a SimpleFIN setup token after checking your bank in its selector. AmFirst coverage is unverified. Refresh is on request, with an hourly cache. Bank balances are reference values. Pending rows and automatic reconciliation of changed records are not imported.", cost: "SimpleFIN subscription" };
    if (provider.id === "market") return { ...provider, name: "Finnhub market prices", status: process.env.FINNHUB_API_KEY ? "configured" : "needs_configuration", implementation: "implemented", capabilities: ["U.S. stock and ETF price preview", "Confirm dated valuation"], needs: "A server API key and a suitable provider license are needed. Personal-use pricing does not authorize public redistribution. Fund look-through and historical index feeds are separate licensed products.", cost: "Free personal plan where eligible" };
    if (provider.id === "smtp") return { ...provider, status: process.env.BUDGETCENTS_MAIL_ENABLED === "true" && process.env.SMTP_URL && process.env.SMTP_FROM ? "configured" : "local_outbox", implementation: "implemented", capabilities: ["Account email queue", "Generic alert email", "Explicit test to verified address"], needs: "Set the SMTP server, sender, public HTTPS address, and mail enable switch. Resend SMTP or another SMTP host can be used. Provider acceptance does not prove inbox delivery. Old local-outbox copies are never sent automatically.", cost: "Mail host plan" };
    if (provider.id === "push") return { ...provider, status: process.env.BUDGETCENTS_PUSH_ENABLED === "true" && process.env.FCM_SERVICE_ACCOUNT_JSON ? "configured" : "needs_configuration", implementation: "implemented", capabilities: ["Android enrollment", "FCM HTTP v1", "Generic remote notifications"], needs: "Configure the server service account and Android Firebase app, then enroll each phone with consent. Device receipts report notification posting; provider acceptance alone does not prove delivery.", cost: "FCM has no messaging charge" };
    return provider;
  });
}
