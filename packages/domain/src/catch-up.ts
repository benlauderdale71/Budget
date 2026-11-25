import { addDays } from "./dates.js";
import type { ForecastEvent } from "./forecast.js";

export interface CatchUpBill {
  name:string;
  pastDueMinor:number;
  regular:{date:string;amountMinor:number}|null;
  agreements:{date:string;amountMinor:number}[];
}

export interface CatchUpTerms extends CatchUpBill {
  additionalBills?:CatchUpBill[];
  asOf: string;
  days: number;
  bufferMinor: number;
  essentialsPerPayMinor: number;
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
  const bills=[terms,...(terms.additionalBills??[])];
  for(const bill of bills) {
  if (bill.regular) {
    const day = byDate.get(bill.regular.date);
    if (day) day.billsMinor += bill.regular.amountMinor;
  }
  for (const agreement of bill.agreements) {
    const day = byDate.get(agreement.date);
    if (day) day.agreedMinor += agreement.amountMinor;
  }
  }
  const creditors=bills.map(b=>({name:b.name,remainingMinor:b.pastDueMinor,extraMinor:0,unfundedMinor:0,firstUnfundedDate:null as string|null,
    availableExtra:b.pastDueMinor-b.agreements.reduce((sum,p)=>sum+p.amountMinor,0)}));
  let base = startingMinor;
  const balances = daily.map(day => {
    if (day.payMinor) day.essentialsMinor = terms.essentialsPerPayMinor;
    base += day.payMinor - day.billsMinor - day.essentialsMinor - day.agreedMinor;
    return base;
  });
  // Protect every later bill and agreed installment before offering extra money from a paycheck.
  const floor = balances.slice();
  for (let i=floor.length-2;i>=0;i--) floor[i]=Math.min(floor[i],floor[i+1]);
  let extras = 0, lowestMinor = startingMinor, lowestDate = terms.asOf;
  let payoffDate: string | null = null;
  let firstShortfall: string | null = startingMinor < 0 ? terms.asOf : null;

  const rows = daily.map((day,i) => {
    const available = Math.max(0, floor[i]-extras-terms.bufferMinor);
    let budget=Math.min(day.payMinor,available);
    let cashForAgreements=Math.max(0,balances[i]+day.agreedMinor-extras);
    const payments=bills.map((bill,index)=>{
      const creditor=creditors[index];
      const agreed=bill.agreements.filter(p=>p.date===day.date).reduce((sum,p)=>sum+p.amountMinor,0);
      const extra=Math.min(budget,creditor.availableExtra);
      const unfunded=Math.max(0,agreed-cashForAgreements);
      if(unfunded && !creditor.firstUnfundedDate) creditor.firstUnfundedDate=day.date;
      cashForAgreements=Math.max(0,cashForAgreements-agreed);
      budget-=extra;
      creditor.availableExtra-=extra;
      creditor.extraMinor+=extra;
      creditor.unfundedMinor+=unfunded;
      creditor.remainingMinor-=extra+agreed;
      return {name:bill.name,agreed,extra,unfunded};
    }).filter(p=>p.agreed||p.extra);
    const extraMinor=payments.reduce((sum,p)=>sum+p.extra,0);
    extras+=extraMinor;
    const balanceMinor = balances[i]-extras;
    if (balanceMinor < lowestMinor) { lowestMinor = balanceMinor; lowestDate = day.date; }
    if (balanceMinor < 0 && !firstShortfall) firstShortfall = day.date;
    const remainingMinor = creditors.reduce((sum,c)=>sum+c.remainingMinor,0);
    if (!remainingMinor && !payoffDate && !firstShortfall) payoffDate = day.date;
    return {...day, payments, extraMinor, remainingMinor, balanceMinor};
  });
  return { creditors,startingMinor, lowestMinor, lowestDate, firstShortfall, payoffDate,
    remainingMinor: rows.at(-1)?.remainingMinor ?? terms.pastDueMinor,
    rows: rows.filter(r=>r.payMinor || r.agreedMinor || r.billsMinor) };
}
