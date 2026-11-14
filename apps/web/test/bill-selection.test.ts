import { test } from "node:test";
import assert from "node:assert/strict";
import { selectBills } from "../src/bill-selection.ts";
test("select all spans pages and skips estimates, totals and known matches",()=>{
  const rows=Array.from({length:37},(_,i)=>({key:String(i),kind:"bill",selected:false}));
  const result=selectBills([...rows,{key:"estimate",kind:"estimate",selected:false},{key:"total",kind:"ignore",selected:false},{key:"match",kind:"bill",selected:false,duplicate:true}],"all",true);
  assert.equal(result.filter(r=>r.selected).length,37);assert.equal(rows[0].selected,false);
});
test("filtered selection preserves other kinds and clearing selected spans all pages",()=>{
  const rows=[{key:"bill",kind:"bill",selected:false},{key:"income",kind:"income",selected:true},{key:"sub",kind:"subscription",selected:false}];
  const picked=selectBills(rows,"bill",true);assert.deepEqual(picked.map(r=>r.selected),[true,true,false]);
  assert.deepEqual(selectBills(picked,"bill",false).map(r=>r.selected),[false,true,false]);
  assert.deepEqual(selectBills(picked,"selected",false).map(r=>r.selected),[false,false,false]);
});
