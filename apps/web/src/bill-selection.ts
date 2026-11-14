interface SelectableBill { key:string; kind:string; selected:boolean; duplicate?:boolean }
export function billMatchesFilter(row:SelectableBill,filter:string) { return filter==="all" || filter==="selected"&&row.selected || filter===row.kind; }
/** The filter applies to the complete preview, before pagination. */
export function selectBills<T extends SelectableBill>(rows:T[],filter:string,selected:boolean):T[] {
  return rows.map(row=>billMatchesFilter(row,filter) && (!selected || ["bill","subscription","income"].includes(row.kind)&&!row.duplicate) ? {...row,selected} : row);
}
