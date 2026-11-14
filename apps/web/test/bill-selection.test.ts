import { test } from "node:test";
import assert from "node:assert/strict";
import { billMatchesFilter, deselectIncompleteBills, selectBills } from "../src/bill-selection.ts";
test("select all spans pages and skips estimates, totals and known matches",()=>{
  const rows=Array.from({length:37},(_,i)=>({key:String(i),kind:"bill",selected:false}));
  const result=selectBills([...rows,{key:"estimate",kind:"estimate",selected:false},{key:"total",kind:"ignore",selected:false},{key:"match",kind:"bill",selected:false,duplicate:true}],"all",true);
  assert.equal(result.filter(r=>r.selected).length,37);assert.equal(rows[0].selected,false);
});
test("deselecting incomplete rows preserves the completed selection and every editable value",()=>{
  const rows=Array.from({length:48},(_,i)=>({key:String(i),kind:i%3?"bill":"income",selected:true,name:`Item ${i}`,amount:i<32?"12.34":"",nextDate:i<32?"2026-12-15":""}));
  const missing=rows.slice(32).map(row=>row.key),result=deselectIncompleteBills(rows,missing);
  assert.equal(result.filter(row=>row.selected).length,32);
  assert.deepEqual(result.map(({selected,...fields})=>fields),rows.map(({selected,...fields})=>fields));
  assert.equal(rows.filter(row=>row.selected).length,48);
  assert.equal(selectBills(result,"all",true).filter(row=>row.selected).length,48);
});
test("an attention view remains stable while values are corrected and its bulk controls stay in scope",()=>{
  const rows=[{key:"ready",kind:"bill",selected:true,amount:"12.34"},{key:"missing",kind:"bill",selected:true,amount:""}];
  const attentionKeys=["missing"];
  const corrected=rows.map(row=>row.key==="missing"?{...row,amount:"5"}:row);
  assert.deepEqual(corrected.filter(row=>billMatchesFilter(row,"attention",attentionKeys)).map(row=>row.key),["missing"]);
  assert.deepEqual(selectBills(corrected,"attention",false,attentionKeys).map(row=>row.selected),[true,false]);
});
test("filtered selection preserves other kinds and clearing selected spans all pages",()=>{
  const rows=[{key:"bill",kind:"bill",selected:false},{key:"income",kind:"income",selected:true},{key:"sub",kind:"subscription",selected:false}];
  const picked=selectBills(rows,"bill",true);assert.deepEqual(picked.map(r=>r.selected),[true,true,false]);
  assert.deepEqual(selectBills(picked,"bill",false).map(r=>r.selected),[false,true,false]);
  assert.deepEqual(selectBills(picked,"selected",false).map(r=>r.selected),[false,false,false]);
});
