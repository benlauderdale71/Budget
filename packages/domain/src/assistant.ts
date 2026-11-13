export interface AssistantFact {
  id: string;
  label: string;
  amountMinor?: number;
  text?: string;
  from?: string;
  to?: string;
  transactionIds?: string[];
  formula?: string;
  asOf?: string;
}

export interface AssistantAnswer {
  text: string;
  facts: AssistantFact[];
  missing: string[];
  /** Actions the user may confirm. Nothing here has been executed. */
  proposedActions: { type: string; label: string; payload?: Record<string, string> }[];
}

/**
 * Answers from facts the ledger already computed. It does not estimate a balance
 * when the fact is absent, and it does not treat user text as instructions to run.
 */
export function answerFinanceQuestion(question: string, facts: AssistantFact[]): AssistantAnswer {
  const q = question.toLowerCase();
  const want = (id: string) => facts.find((fact) => fact.id === id);
  const missing: string[] = [];
  const used: AssistantFact[] = [];
  const take = (id: string) => {
    const fact = want(id);
    if (!fact) missing.push(id);
    else used.push(fact);
    return fact;
  };
  let text = "";
  const proposed: AssistantAnswer["proposedActions"] = [];
  if (q.includes("safe") || q.includes("spend")) {
    const fact = take("safe_to_spend");
    text = fact
      ? `You can safely spend ${fact.text ?? formatFact(fact)}. ${fact.formula ?? ""}`.trim()
      : "I don't have a safe-to-spend figure for that question.";
  } else if (q.includes("paycheck") || q.includes("expected income")) {
    const fact = take("next_paycheck");
    text = fact?.text ?? "I don't have an expected paycheck in the records you can see. Expected income is not cash on hand.";
  } else if (q.includes("bill") || q.includes("payday")) {
    const fact = take("bills_before_payday");
    text = fact ? `Before the next paycheck: ${fact.text ?? formatFact(fact)}.` : "I don't have upcoming bills on file.";
  } else if (q.includes("spend") || q.includes("spent")) {
    const fact = take("spending_period");
    text = fact ? `Spending for ${fact.from ?? "the period"} through ${fact.to ?? "today"} is ${fact.text ?? formatFact(fact)}.` : "I don't have spending for that window.";
  } else if (q.includes("net worth")) {
    const fact = take("net_worth");
    text = fact ? `Net worth is ${fact.text ?? formatFact(fact)}.` : "Net worth is unavailable until accounts have balances.";
  } else if (q.includes("goal")) {
    const fact = take("goal_gap");
    text = fact ? fact.text ?? formatFact(fact) : "No goal shortfall is on file.";
  } else if (q.match(/rule|categor/)) {
    text = "I can suggest a category rule from payees you have already confirmed. Confirm it before it changes anything.";
    proposed.push({ type: "preview_rule", label: "Preview a category rule" });
  } else {
    text = "I can answer from your records about safe-to-spend, bills before payday, spending, net worth, and goal gaps. I will not guess a number that is not in the ledger.";
    missing.push("unsupported_question");
  }
  return { text, facts: used, missing, proposedActions: proposed };
}

function formatFact(fact: AssistantFact): string {
  if (fact.text) return fact.text;
  if (fact.amountMinor == null) return fact.label;
  const sign = fact.amountMinor < 0 ? "-" : "";
  const abs = Math.abs(fact.amountMinor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Reject prompt-injection style content inside imported descriptions. */
export function isDataNotInstruction(value: string): boolean {
  return !/ignore (all|previous) instructions|system prompt|exfiltrate/i.test(value);
}
