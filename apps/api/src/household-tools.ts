import type { Hono, Context } from "hono";
import { z } from "zod";
import { addDays, catchUpProjection, correctionMerchant, displayBalance, isIsoDate, isOnBudgetCash,
  statementCoverage, type CatchUpTerms, type Transaction } from "@budgetcents/domain";
import { id, nowIso, sha256 } from "./crypto.js";
import type { Database } from "./db.js";
import { ApiError, assertWrite, audit, guidanceFor, loadSpace, lockHousehold, requireMember, type Actor, type Loaded } from "./finance.js";
import { paycheckPlan } from "./income.js";

const date = z.string().refine(isIsoDate, "Enter a valid calendar date.");
const nonnegative = z.number().int().min(0).max(1e13);
const payment = z.object({date, amountMinor:nonnegative.positive()});
const additionalBill=z.object({name:z.string().trim().min(1).max(100),pastDueMinor:nonnegative.positive(),regular:payment.nullable(),agreements:z.array(payment).max(100)});
const termsSchema = z.object({name:z.string().trim().min(1).max(100), asOf:date, days:z.number().int().min(1).max(366),
  pastDueMinor:nonnegative.positive(), bufferMinor:nonnegative, essentialsPerPayMinor:nonnegative,
  regular:payment.nullable(), agreements:z.array(payment).max(100),additionalBills:z.array(additionalBill).max(50).optional()});
type Batch = {id:string; account_id:string; bucket_id:string; merchant_key:string; future:number; undone:number; created_at:string};

function accountIn(loaded: Loaded, accountId: string) {
  const account = loaded.input.accounts.find(a => a.id === accountId && loaded.visibleAccountIds.has(a.id));
  if (!account || account.id.startsWith("redacted:")) throw new ApiError(404,"Account unavailable in this space.");
  return account;
}

export async function coverageFor(db:Database, loaded:Loaded, year:number, accountId?:string) {
  if (accountId) accountIn(loaded,accountId);
  const ids = loaded.input.accounts.filter(a => loaded.visibleAccountIds.has(a.id) && (!accountId || accountId===a.id)).map(a=>a.id);
  const periods = ids.length ? await db.query<{account_id:string;start_date:string;end_date:string;closing_minor:number;deposits_minor:number|null;withdrawals_minor:number|null;transaction_count:number|null}>(
    "SELECT * FROM statement_periods WHERE account_id=ANY($1::text[]) AND start_date <= $2 AND end_date >= $3",
    [ids,`${year}-12-31`,`${year}-01-01`]) : [];
  const dates=await db.query<{account_id:string;opened:string|null;closed:string|null}>("SELECT * FROM account_lifetimes WHERE account_id=ANY($1::text[])",[ids]);
  return statementCoverage({...loaded.input, transactions:loaded.balanceTransactions},year,periods.map(p=>({accountId:p.account_id,start:p.start_date,end:p.end_date,closingMinor:p.closing_minor,depositsMinor:p.deposits_minor,withdrawalsMinor:p.withdrawals_minor,transactionCount:p.transaction_count})),accountId,Object.fromEntries(dates.map(d=>[d.account_id,d])));
}

function editable(t: Transaction) {
  return !t.deleted && t.bankStatus==="posted" && !t.counterAccountId && !t.locked && !t.reconciled && !t.excludeFromReports
    && t.splits.length<=1 && (!t.splits.length || (t.splits[0].amountMinor===Math.abs(t.amountMinor)
      && t.splits[0].role===(t.amountMinor<0?"expense":"income")));
}

async function applyCorrection(db: Database, batchId:string, txn:Transaction, bucketId:string) {
  const version = txn.version ?? 1;
  const changed = await db.query("UPDATE transactions SET version=version+1, updated_at=$1 WHERE id=$2 AND version=$3 AND locked=0 AND reconciled=0 AND deleted=0 RETURNING version",
    [nowIso(),txn.id,version]);
  if (!changed.length) throw new ApiError(409,"A matching transaction changed. Preview the correction again.");
  const [split] = await db.query<{id:string;bucket_id:string|null}>("SELECT id,bucket_id FROM splits WHERE transaction_id=$1",[txn.id]);
  const splitId = split?.id ?? id();
  if (split) await db.query("UPDATE splits SET bucket_id=$1 WHERE id=$2",[bucketId,splitId]);
  else await db.query("INSERT INTO splits(id,transaction_id,bucket_id,amount_minor,role) VALUES($1,$2,$3,$4,$5)",
    [splitId,txn.id,bucketId,Math.abs(txn.amountMinor),txn.amountMinor<0?"expense":"income"]);
  const estimate=await db.query("DELETE FROM transaction_tags WHERE transaction_id=$1 AND tag='category-estimate' RETURNING tag",[txn.id]);
  await db.query("INSERT INTO merchant_correction_rows(batch_id,transaction_id,split_id,prior_bucket,inserted_split,applied_version,removed_estimate) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [batchId,txn.id,splitId,split?.bucket_id ?? null,split?0:1,version+1,estimate.length]);
}

export async function correctFutureImport(db:Database, txn:Transaction) {
  if (!(txn.importBatchId || txn.providerTransactionId) || !editable(txn) || txn.categoryLockedByUser || txn.reviewStatus==="reviewed") return;
  const key = correctionMerchant(txn);
  if (!key) return;
  const [rule] = await db.query<Batch>(
    "SELECT m.* FROM merchant_corrections m JOIN buckets b ON b.id=m.bucket_id JOIN transactions t ON t.id=$3 AND t.space_id=b.space_id WHERE m.account_id=$1 AND m.merchant_key=$2 AND m.future=1 AND m.undone=0 AND b.archived=0 AND b.hidden=0 AND b.system_role IS NULL FOR UPDATE OF m",
    [txn.accountId,key,txn.id]);
  if (rule && txn.splits[0]?.bucketId!==rule.bucket_id) await applyCorrection(db,rule.id,txn,rule.bucket_id);
}

export function mountHouseholdTools(app:Hono, db:Database, actor:(c:Context)=>Promise<Actor>) {
  const base="/api/households/:hid";
  async function context(c:Context,write=false) {
    const me=await actor(c), hid=c.req.param("hid")!;
    if (write) {
      assertWrite(await requireMember(db,me.id,hid));
      await lockHousehold(db,hid);
    }
    const loaded=await loadSpace(db,me,hid,c.req.query("spaceId"));
    if (write) assertWrite(loaded.member);
    return {me,hid,loaded};
  }
  app.get(base+"/statement-coverage",async c=>{
    const {loaded}=await context(c);
    const year=z.coerce.number().int().min(1900).max(2200).parse(c.req.query("year") ?? loaded.input.asOf.slice(0,4));
    return c.json(await coverageFor(db,loaded,year,c.req.query("accountId")));
  });
  app.post(base+"/account-lifetime",async c=>{
    const b=z.object({accountId:z.string(),opened:date.nullable(),closed:date.nullable(),previous:z.object({opened:date.nullable(),closed:date.nullable()})}).parse(await c.req.json());
    return c.json(await db.tx(async()=>{
      const {loaded,hid}=await context(c,true);
      await lockHousehold(db,hid);
      accountIn(loaded,b.accountId);
      if (b.opened && b.closed && b.opened>b.closed) throw new ApiError(400,"Closing date precedes opening date.");
      if(loaded.balanceTransactions.some(t=>!t.deleted && t.bankStatus==="posted" && (t.accountId===b.accountId || t.counterAccountId===b.accountId) && ((b.opened && t.date<b.opened)||(b.closed && t.date>b.closed)))) throw new ApiError(400,"These dates exclude an existing posted transaction.");
      const [old]=await db.query("SELECT opened,closed FROM account_lifetimes WHERE account_id=$1",[b.accountId]);
      if ((old?.opened??null)!==b.previous.opened || (old?.closed??null)!==b.previous.closed) throw new ApiError(409,"Account dates changed. Reload before saving.");
      await db.query("INSERT INTO account_lifetimes(account_id,opened,closed) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET opened=excluded.opened,closed=excluded.closed",[b.accountId,b.opened,b.closed]);
      return {saved:true};
    }));
  });
  const evidence={depositsMinor:nonnegative.nullish(),withdrawalsMinor:nonnegative.nullish(),transactionCount:z.number().int().min(0).max(10000000).nullish()};
  app.post(base+"/statement-coverage",async c=>{
    const body=z.object({accountId:z.string(),start:date,end:date,closingMinor:z.number().safe().int(),
      ...evidence,previous:z.object({start:date,closingMinor:z.number().safe().int(),...evidence}).nullable()}).parse(await c.req.json());
    return c.json(await db.tx(async()=>{
      const {loaded,me,hid}=await context(c,true);
      const a=accountIn(loaded,body.accountId);
      await lockHousehold(db,hid);
      if (body.end<body.start || body.end>loaded.input.asOf) throw new ApiError(400,"Use a statement period ending on or before today.");
      const [old]=await db.query("SELECT * FROM statement_periods WHERE account_id=$1 AND end_date=$2",[a.id,body.end]);
      const sameEvidence=(values:typeof body.previous)=> (old?.deposits_minor??null)===(values?.depositsMinor??null) && (old?.withdrawals_minor??null)===(values?.withdrawalsMinor??null) && (old?.transaction_count??null)===(values?.transactionCount??null);
      if (old?.start_date===body.start && old?.closing_minor===body.closingMinor && sameEvidence(body)) return {saved:true};
      if ((old?.start_date ?? null)!==(body.previous?.start ?? null) || (old?.closing_minor ?? null)!==(body.previous?.closingMinor ?? null) || !sameEvidence(body.previous))
        throw new ApiError(409,"Reload the statement before replacing its dates or balance.");
      await db.query("INSERT INTO statement_periods(account_id,start_date,end_date,closing_minor,deposits_minor,withdrawals_minor,transaction_count) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,end_date) DO UPDATE SET start_date=excluded.start_date,closing_minor=excluded.closing_minor,deposits_minor=excluded.deposits_minor,withdrawals_minor=excluded.withdrawals_minor,transaction_count=excluded.transaction_count",
        [a.id,body.start,body.end,body.closingMinor,body.depositsMinor??null,body.withdrawalsMinor??null,body.transactionCount??null]);
      await audit(db,hid,me.id,"statement.recorded","Recorded statement period and closing balance","account",a.id);
      return {saved:true};
    }));
  });

  app.get(base+"/catch-up",async c=>{
    const {me,loaded}=await context(c);
    const a=accountIn(loaded,c.req.query("accountId") ?? "");
    const [row]=await db.query("SELECT terms_json,version FROM catch_up_plans WHERE account_id=$1 AND user_id=$2",[a.id,me.id]);
    return c.json({terms:row ? JSON.parse(String(row.terms_json)) as CatchUpTerms : null, version:row?.version ?? 0});
  });
  app.post(base+"/catch-up",async c=>{
    const body=z.object({accountId:z.string(),terms:termsSchema,save:z.boolean().default(false),version:z.number().int().min(0).default(0)}).parse(await c.req.json());
    const {terms}=body;
    const end=addDays(terms.asOf,terms.days-1);
    for(const bill of [terms,...(terms.additionalBills??[])]) {
    if ([...bill.agreements,...(bill.regular?[bill.regular]:[])].some(p=>p.date<terms.asOf || p.date>end))
      throw new ApiError(400,"Every payment must fall inside the forecast dates.");
    if (bill.agreements.reduce((sum,p)=>sum+p.amountMinor,0)>bill.pastDueMinor) throw new ApiError(400,"Agreed payments exceed the past-due balance for "+bill.name);
    }
    return c.json(await db.tx(async()=>{
      const {me,hid,loaded}=await context(c,body.save);
      const a=accountIn(loaded,body.accountId);
      if (!isOnBudgetCash(a) || a.currency!==loaded.input.currency) throw new ApiError(400,"Choose a budget cash account in this plan’s currency.");
      const dated=await loadSpace(db,me,hid,loaded.spaceId,terms.asOf);
      const pay=await paycheckPlan(db,me,hid,{spaceId:loaded.spaceId,asOf:terms.asOf,from:terms.asOf,to:end});
      const scheduled=guidanceFor(dated,terms.days-1).events.filter(e=>e.accountId===a.id);
      const income=pay.upcoming.filter(p=>p.accountId===a.id && p.inFutureForecast).map(p=>({
        id:p.key,date:p.date,amountMinor:p.amountMinor,kind:"income" as const,label:p.name}));
      const result=catchUpProjection(terms,displayBalance(a,dated.balanceTransactions,terms.asOf),[...scheduled,...income]);
      let version=body.version;
      if (body.save) {
        const [old]=await db.query("SELECT version,terms_json FROM catch_up_plans WHERE account_id=$1 AND user_id=$2",[a.id,me.id]);
        if (old?.terms_json===JSON.stringify(terms)) version=Number(old.version);
        else {
          if (Number(old?.version ?? 0)!==version) throw new ApiError(409,"This plan changed. Reopen it before saving.");
          version++;
          await db.query("INSERT INTO catch_up_plans(account_id,user_id,terms_json,version) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,user_id) DO UPDATE SET terms_json=excluded.terms_json,version=excluded.version",
            [a.id,me.id,JSON.stringify(terms),version]);
        }
      }
      return {...result,version,end};
    }));
  });

  app.post(base+"/merchant-corrections",async c=>{
    const body=z.object({sourceId:z.string(),bucketId:z.string(),future:z.boolean(),confirm:z.string().length(64).optional()}).parse(await c.req.json());
    return c.json(await db.tx(async()=>{
      const {me,hid,loaded}=await context(c,true);
      const source=loaded.input.transactions.find(t=>t.id===body.sourceId);
      if (!source || !editable(source)) throw new ApiError(400,"Choose an unlocked, posted purchase or income transaction with one category.");
      accountIn(loaded,source.accountId);
      const key=correctionMerchant(source);
      if (!key) throw new ApiError(400,"The description does not identify a merchant reliably.");
      const bucket=loaded.input.buckets.find(b=>b.id===body.bucketId && !b.archived && !b.hidden && !b.systemRole && b.kind===(source.amountMinor<0?"expense":"income"));
      if (!bucket) throw new ApiError(400,"Choose an active category for this transaction type.");
      if (body.confirm) {
        const [done]=await db.query("SELECT id FROM merchant_corrections WHERE account_id=$1 AND creator_id=$2 AND preview_token=$3 AND undone=0",[source.accountId,me.id,body.confirm]);
        if (done) return {batchId:done.id,alreadyApplied:true};
      }
      const matches=loaded.input.transactions.filter(t=>t.accountId===source.accountId && editable(t) && correctionMerchant(t)===key
        && (t.id===source.id || (t.reviewStatus==="needs_review" && !t.categoryLockedByUser)) && t.splits[0]?.bucketId!==bucket.id).sort((a,b)=>a.id.localeCompare(b.id));
      const token=sha256(JSON.stringify([me.id,hid,source.id,key,bucket.id,body.future,matches.map(t=>[t.id,t.version])]));
      const rows=matches.map(t=>({id:t.id,date:t.date,payee:t.payee,amountMinor:t.amountMinor,priorBucket:t.splits[0]?.bucketId ?? null}));
      if (!body.confirm) return {token,rows};
      if (token!==body.confirm) throw new ApiError(409,"Matches changed. Preview again.");
      if (!matches.length && !body.future) throw new ApiError(400,"There are no changes to apply.");
      if (body.future && (await db.query("SELECT id FROM merchant_corrections WHERE account_id=$1 AND merchant_key=$2 AND future=1 AND undone=0",[source.accountId,key])).length)
        throw new ApiError(409,"A future correction already exists for this merchant. Undo that batch before replacing its rule.");
      const batch=id();
      await db.query("INSERT INTO merchant_corrections(id,account_id,creator_id,merchant_key,bucket_id,future,created_at,preview_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [batch,source.accountId,me.id,key,bucket.id,body.future?1:0,nowIso(),token]);
      for (const t of matches) await applyCorrection(db,batch,t,bucket.id);
      await audit(db,hid,me.id,"merchant.correction",`Corrected ${matches.length} matching records`,"account",source.accountId);
      return {batchId:batch,applied:matches.length};
    }));
  });
  app.get(base+"/merchant-corrections",async c=>{
    const {me,loaded}=await context(c);
    const ids=loaded.input.accounts.filter(a=>loaded.visibleAccountIds.has(a.id)).map(a=>a.id);
    const rows=await db.query("SELECT m.id,m.account_id,m.merchant_key,m.bucket_id,m.future,m.created_at,COUNT(r.transaction_id)::int AS count FROM merchant_corrections m LEFT JOIN merchant_correction_rows r ON r.batch_id=m.id WHERE m.creator_id=$1 AND m.account_id=ANY($2::text[]) AND m.undone=0 GROUP BY m.id ORDER BY m.created_at DESC",[me.id,ids]);
    return c.json({batches:rows});
  });
  app.post(base+"/merchant-corrections/:batch/undo",async c=>c.json(await db.tx(async()=>{
    const {me,hid,loaded}=await context(c,true);
    const [batch]=await db.query<Batch>("SELECT * FROM merchant_corrections WHERE id=$1 AND creator_id=$2 FOR UPDATE",[c.req.param("batch"),me.id]);
    if (!batch) throw new ApiError(404,"Batch unavailable.");
    accountIn(loaded,batch.account_id);
    if (batch.undone) return {undone:true,restored:0,skipped:0};
    const rows=await db.query<{transaction_id:string;split_id:string;prior_bucket:string|null;inserted_split:number;removed_estimate:number;applied_version:number}>("SELECT * FROM merchant_correction_rows WHERE batch_id=$1",[batch.id]);
    let restored=0;
    for (const row of rows) {
      const changed=await db.query("UPDATE transactions SET version=version+1,updated_at=$1 WHERE id=$2 AND household_id=$3 AND account_id=$4 AND version=$5 AND deleted=0 AND locked=0 AND reconciled=0 AND EXISTS(SELECT 1 FROM splits WHERE id=$6 AND transaction_id=$2 AND bucket_id=$7) RETURNING id",
        [nowIso(),row.transaction_id,hid,batch.account_id,row.applied_version,row.split_id,batch.bucket_id]);
      if (!changed.length) continue;
      if (row.inserted_split) await db.query("DELETE FROM splits WHERE id=$1",[row.split_id]);
      else await db.query("UPDATE splits SET bucket_id=$1 WHERE id=$2",[row.prior_bucket,row.split_id]);
      if (row.removed_estimate) await db.query("INSERT INTO transaction_tags(transaction_id,tag) VALUES($1,'category-estimate') ON CONFLICT DO NOTHING",[row.transaction_id]);
      restored++;
    }
    await db.query("UPDATE merchant_corrections SET undone=1 WHERE id=$1",[batch.id]);
    await audit(db,hid,me.id,"merchant.undo",`Restored ${restored} categories`,"account",batch.account_id);
    return {undone:true,restored,skipped:rows.length-restored};
  })));
}
