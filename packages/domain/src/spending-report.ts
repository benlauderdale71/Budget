import { addDays, daysBetween, isIsoDate } from "./dates.js";
import { spendingContributions } from "./reports.js";
import type { EngineInput } from "./types.js";

export interface SpendingFilters { from: string; to: string; accountId?: string; bucketId?: string; group?: string; merchant?: string; tag?: string; q?: string }
export interface SpendingLine {
  key: string; transactionId: string; date: string; accountId: string; account: string;
  bucketId: string; category: string; group: string; merchant: string; amountMinor: number;
  type: string; notes: string; memo: string; tags: string[]; reviewStatus: string; cleared: boolean; reconciled: boolean;
}
export interface SpendingTotals {
  grossMinor: number; refundsMinor: number; netMinor: number; count: number;
  dailyAverageMinor: number; averageTransactionMinor: number; uncategorizedMinor: number; uncategorizedCount: number;
}
export interface SpendingBreakdown extends SpendingTotals {
  key: string; label: string; group?: string; previousMinor: number; changeMinor: number; changeBps: number | null; shareBps: number;
}
export function spendingRangeError(from: string, to: string): string | null {
  if (!isIsoDate(from) || !isIsoDate(to) || from < "1900-01-01" || to > "2200-12-31") return "Choose valid dates between 1900 and 2200.";
  if (from > to) return "The start date must be on or before the end date.";
  if (daysBetween(from, to) > 3660) return "Choose a date range of ten years or less.";
  return null;
}
function totals(lines: SpendingLine[], days: number): SpendingTotals {
  const grossMinor = lines.reduce((n,l)=>n+Math.max(0,l.amountMinor),0);
  const refundsMinor = lines.reduce((n,l)=>n+Math.max(0,-l.amountMinor),0);
  const count = new Set(lines.map(l=>l.transactionId)).size;
  const uncategorized = lines.filter(l=>l.bucketId === "uncategorized");
  return { grossMinor, refundsMinor, netMinor:grossMinor-refundsMinor, count,
    dailyAverageMinor:Math.round((grossMinor-refundsMinor)/days), averageTransactionMinor:count?Math.round((grossMinor-refundsMinor)/count):0,
    uncategorizedMinor:uncategorized.reduce((n,l)=>n+l.amountMinor,0), uncategorizedCount:new Set(uncategorized.map(l=>l.transactionId)).size };
}
export function detailedSpending(input: EngineInput, filters: SpendingFilters) {
  const error = spendingRangeError(filters.from, filters.to); if(error) throw new Error(error);
  const days = daysBetween(filters.from,filters.to)+1;
  const previousTo = addDays(filters.from,-1), previousFrom = addDays(filters.from,-days);
  const accounts = new Map(input.accounts.filter(a=>!a.id.startsWith("redacted:")).map(a=>[a.id,a]));
  const buckets = new Map(input.buckets.map(b=>[b.id,b]));
  const all: SpendingLine[] = [];
  const excluded = { pending:0, markedExcluded:0, otherCurrency:0, nonSpending:0 };
  for (const txn of input.transactions) {
    const account=accounts.get(txn.accountId);
    if (!account || txn.deleted || filters.accountId && txn.accountId!==filters.accountId) continue;
    const current = txn.date>=filters.from && txn.date<=filters.to;
    if(txn.date<previousFrom || txn.date>filters.to) continue;
    if(txn.bankStatus==="pending") { if(current) excluded.pending++; continue; }
    if(txn.excludeFromReports) { if(current) excluded.markedExcluded++; continue; }
    if(txn.currency!==input.currency) { if(current) excluded.otherCurrency++; continue; }
    const contributions=spendingContributions(txn);
    if(!contributions.length) { if(current) excluded.nonSpending++; continue; }
    for(const split of contributions) {
      const bucket = split.bucketId ? buckets.get(split.bucketId) : undefined;
      all.push({key:`${txn.id}:${split.index}`,transactionId:txn.id,date:txn.date,accountId:account.id,account:account.name,
        bucketId:bucket?.id??"uncategorized",category:bucket?.name??"Uncategorized",group:bucket?.group||"Uncategorized",
        merchant:txn.payee.trim()||"Unknown merchant",amountMinor:split.amountMinor,type:txn.type,
        notes:txn.notes??"",memo:split.memo??"",tags:txn.tags??[],reviewStatus:txn.reviewStatus,cleared:!!txn.cleared,reconciled:!!txn.reconciled});
    }
  }
  const matching = all.filter(l=>(!filters.bucketId||l.bucketId===filters.bucketId)&&(!filters.group||l.group===filters.group)
    &&(!filters.merchant||l.merchant===filters.merchant)&&(!filters.tag||l.tags.includes(filters.tag))
    &&(!filters.q||[l.merchant,l.notes,l.memo,...l.tags].join(" ").toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())));
  const lines = matching.filter(l=>l.date>=filters.from).sort((a,b)=>b.date.localeCompare(a.date)||a.key.localeCompare(b.key));
  const previous = matching.filter(l=>l.date<filters.from);
  const summary = totals(lines,days), prior = totals(previous,days);
  function breakdown(keyOf:(l:SpendingLine)=>string,labelOf:(l:SpendingLine)=>string): SpendingBreakdown[] {
    const grouped = new Map<string,{current:SpendingLine[];past:SpendingLine[];example:SpendingLine}>();
    for(const [items,period] of [[lines,"current"],[previous,"past"]] as const) for(const line of items) {
      const key=keyOf(line);const entry=grouped.get(key)??{current:[],past:[],example:line};entry[period].push(line);grouped.set(key,entry);
    }
    return [...grouped].map(([key,value])=>{ const current=totals(value.current,days), past=totals(value.past,days);
      return {...current,key,label:labelOf(value.example),group:value.example.group,previousMinor:past.netMinor,
        changeMinor:current.netMinor-past.netMinor,changeBps:past.netMinor>0?Math.round((current.netMinor-past.netMinor)/past.netMinor*10000):null,
        shareBps:summary.grossMinor?Math.round(current.grossMinor/summary.grossMinor*10000):0};
    }).sort((a,b)=>b.netMinor-a.netMinor||a.label.localeCompare(b.label));
  }
  const byDay=new Map<string,SpendingLine[]>();for(const line of lines){const list=byDay.get(line.date)??[];list.push(line);byDay.set(line.date,list);}
  const daily=Array.from({length:days},(_,i)=>{const date=addDays(filters.from,i);return {date,...totals(byDay.get(date)??[],1)};});
  const monthlyMap=new Map<string,SpendingLine[]>();for(const line of lines){const month=line.date.slice(0,7);const list=monthlyMap.get(month)??[];list.push(line);monthlyMap.set(month,list);}
  const months=[...new Set(daily.map(d=>d.date.slice(0,7)))];
  return {currency:input.currency,from:filters.from,to:filters.to,previousFrom,previousTo,days,summary,previous:prior,
    changeMinor:summary.netMinor-prior.netMinor,changeBps:prior.netMinor>0?Math.round((summary.netMinor-prior.netMinor)/prior.netMinor*10000):null,
    categories:breakdown(l=>l.bucketId,l=>l.category),groups:breakdown(l=>l.group,l=>l.group),merchants:breakdown(l=>l.merchant,l=>l.merchant),accounts:breakdown(l=>l.accountId,l=>l.account),
    daily,monthly:months.map(date=>({date,...totals(monthlyMap.get(date)??[],daily.filter(d=>d.date.startsWith(date)).length)})),lines,excluded,
    options:{accounts:[...accounts.values()].map(a=>({id:a.id,name:a.name})),categories:input.buckets.filter(b=>b.kind!=="income"&&!b.systemRole).map(b=>({id:b.id,name:b.name,group:b.group})),
      groups:[...new Set(input.buckets.filter(b=>b.kind!=="income"&&!b.systemRole).map(b=>b.group||"Uncategorized"))].sort(),
      merchants:[...new Set(all.map(l=>l.merchant))].sort(),tags:[...new Set(all.flatMap(l=>l.tags))].sort()}};
}
export type DetailedSpendingReport = ReturnType<typeof detailedSpending>;
