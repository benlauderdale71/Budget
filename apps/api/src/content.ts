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
  { id: "manual", name: "Manual and file import", group: "Accounts", status: "active", capabilities: ["Balances", "Transactions", "Holdings you type in"], needs: "None", cost: "Included" },
  { id: "aggregation", name: "Bank aggregation adapter", group: "Accounts", status: "not_configured", capabilities: ["Authorized account linking", "Balances", "Posted and pending transactions"], needs: "Provider client id and secret. BudgetCents never asks for a bank password.", cost: "Provider pricing" },
  { id: "bills", name: "Bill data adapter", group: "Bills", status: "not_configured", capabilities: ["Statement balance", "Minimum due", "Due date"], needs: "Bill-data agreement and user consent", cost: "Provider pricing" },
  { id: "market", name: "Market and fund data", group: "Investments", status: "not_configured", capabilities: ["Prices", "Classification", "Fund look-through where licensed"], needs: "Licensed data agreement. Manual prices stay labeled manual.", cost: "License" },
  { id: "property", name: "Property valuation", group: "Net worth", status: "not_configured", capabilities: ["Estimate", "Dated history"], needs: "Valuation provider key", cost: "Provider pricing" },
  { id: "vehicle", name: "Vehicle valuation", group: "Net worth", status: "not_configured", capabilities: ["Estimate"], needs: "Valuation provider key", cost: "Provider pricing" },
  { id: "credit", name: "Credit reporting", group: "Credit", status: "not_configured", capabilities: ["Score", "Factors", "Report"], needs: "Bureau or reseller agreement and consumer consent. Manual scores stay labeled manual.", cost: "Provider pricing" },
  { id: "sms", name: "Text messaging", group: "Alerts", status: "not_configured", capabilities: ["Opt-in alerts", "Masked summaries"], needs: "Messaging provider and a verified mobile number", cost: "Per message" },
  { id: "savings", name: "Savings transfer partner", group: "Savings", status: "not_configured", capabilities: ["Scheduled transfers", "Status", "Reversals"], needs: "Banking partner. A goal alone does not hold deposits or pay interest.", cost: "Partner terms" },
  { id: "concierge", name: "Cancellation and negotiation", group: "Bills", status: "not_configured", capabilities: ["Authorized requests", "Case status"], needs: "Concierge operator. The case board does not contact a biller by itself.", cost: "Operator pricing" },
  { id: "coaching", name: "Human coaching", group: "Learning", status: "not_configured", capabilities: ["Scheduling handoff"], needs: "A qualified coach. Lessons in the app are not a live session.", cost: "Coach pricing" },
  { id: "tax", name: "Tax-filing handoff", group: "Business", status: "not_configured", capabilities: ["Document checklist", "Status"], needs: "Tax-filing partner. A set-aside is not a filed return.", cost: "Partner pricing" },
  { id: "estate", name: "Will and trust handoff", group: "Estate", status: "not_configured", capabilities: ["Eligibility", "Status"], needs: "Legal-document partner. A checklist is not an executed will.", cost: "Partner pricing" },
  { id: "smtp", name: "Email delivery", group: "Account", status: "local_outbox", capabilities: ["Verification", "Password reset", "Alert email"], needs: "SMTP_URL. Until then, messages stay in the local outbox.", cost: "Mail host" },
  { id: "model", name: "External language model", group: "Assistant", status: "not_configured", capabilities: ["Wording around ledger facts"], needs: "Model provider key. Amounts are still computed in BudgetCents, and the assistant works with the key unset.", cost: "Model pricing" },
] as const;
