import { addDays } from "./dates.js";
import type { ForecastEvent } from "./forecast.js";

export interface CatchUpTerms {
  name: string;
  asOf: string;
  days: number;
  pastDueMinor: number;
  bufferMinor: number;
  essentialsPerPayMinor: number;
  regular: { date: string; amountMinor: number } | null;
  agreements: { date: string; amountMinor: number }[];
}

export function catchUpProjection(terms: CatchUpTerms, startingMinor: number, events: ForecastEvent[]) {
  const daily = Array.from({length:terms.days}, (_,i) => ({
    date:addDays(terms.asOf,i), payMinor:0, billsMinor:0, agreedMinor:0, essentialsMinor:0,
  }));
  const byDate = new Map(daily.map(day => [day.date,day]));
  for (const event of events) {
    const day = byDate.get(event.date);
    if (!day) continue;
    if (event.amountMinor > 0) day.payMinor += event.amountMinor;
    else day.billsMinor -= event.amountMinor;
  }
  if (terms.regular) {
    const day = byDate.get(terms.regular.date);
    if (day) day.billsMinor += terms.regular.amountMinor;
  }
  for (const agreement of terms.agreements) {
    const day = byDate.get(agreement.date);
    if (day) day.agreedMinor += agreement.amountMinor;
  }
  let base = startingMinor;
  const balances = daily.map(day => {
    if (day.payMinor) day.essentialsMinor = terms.essentialsPerPayMinor;
    base += day.payMinor - day.billsMinor - day.essentialsMinor - day.agreedMinor;
    return base;
  });
  // Protect every later bill and agreed installment before offering extra money from a paycheck.
  const floor = balances.slice();
  for (let i=floor.length-2;i>=0;i--) floor[i]=Math.min(floor[i],floor[i+1]);
  let extras = 0, paid = 0, lowestMinor = startingMinor, lowestDate = terms.asOf;
  let payoffDate: string | null = null;
  let firstShortfall: string | null = startingMinor < 0 ? terms.asOf : null;
  const totalAgreed = terms.agreements.reduce((sum,p)=>sum+p.amountMinor,0);
  const rows = daily.map((day,i) => {
    const available = Math.max(0, floor[i]-extras-terms.bufferMinor);
    const extraMinor = Math.min(day.payMinor, available, Math.max(0, terms.pastDueMinor-totalAgreed-extras));
    extras += extraMinor;
    paid += extraMinor + day.agreedMinor;
    const balanceMinor = balances[i]-extras;
    if (balanceMinor < lowestMinor) { lowestMinor = balanceMinor; lowestDate = day.date; }
    if (balanceMinor < 0 && !firstShortfall) firstShortfall = day.date;
    const remainingMinor = Math.max(0,terms.pastDueMinor-paid);
    if (!remainingMinor && !payoffDate && !firstShortfall) payoffDate = day.date;
    return {...day, extraMinor, remainingMinor, balanceMinor};
  });
  return { startingMinor, lowestMinor, lowestDate, firstShortfall, payoffDate,
    remainingMinor: rows.at(-1)?.remainingMinor ?? terms.pastDueMinor,
    rows: rows.filter(r=>r.payMinor || r.agreedMinor || r.billsMinor) };
}
