const glyphs:Record<string,string>={
  Home:"m3 10 9-7 9 7 M5 9v12h5v-7h4v7h5V9",
  Activity:"M3 7h16m-4-4 4 4-4 4 M21 17H5m4-4-4 4 4 4",
  Assets:"m3 7 9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10",
  Markets:"M3 3v17h18 M6 15l5-6 4 3 6-8",
  "All tools":"M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  Account:"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21a8 8 0 0 1 16 0",
};
export function SuiteIcon({name}:{name:string}) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name]}/></svg>;
}
