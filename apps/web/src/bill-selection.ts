interface SelectableBill { key:string; kind:string; selected:boolean; duplicate?:boolean }
export function billMatchesFilter(row:SelectableBill,filter:string,attentionKeys:readonly string[]=[]) { return filter==="all" || filter==="selected"&&row.selected || filter==="attention"&&attentionKeys.includes(row.key) || filter===row.kind; }
/** The filter applies to the complete preview, before pagination. */
export function selectBills<T extends SelectableBill>(rows:T[],filter:string,selected:boolean,attentionKeys:readonly string[]=[]):T[] {
  return rows.map(row=>billMatchesFilter(row,filter,attentionKeys) && (!selected || ["bill","subscription","income"].includes(row.kind)&&!row.duplicate) ? {...row,selected} : row);
}
export function deselectIncompleteBills<T extends SelectableBill>(rows:T[],incompleteKeys:readonly string[]):T[] {
  return rows.map(row=>row.selected&&incompleteKeys.includes(row.key)?{...row,selected:false}:row);
}
