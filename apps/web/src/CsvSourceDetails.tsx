import { useSession } from "./session.js";

export type SourceCell = { column: string; value: string };

export function CsvSourceDetails({ cells }: { cells: SourceCell[] }) {
  const { user } = useSession();
  return <details>
    <summary>Original CSV columns ({cells.length})</summary>
    {user?.privacyMode ? <p>Turn off Hide amounts to view the original bank details.</p> : <dl>
      {cells.map((cell, index) => <div key={index} style={{ overflowWrap: "anywhere", marginBottom: 8 }}>
        <dt><strong>{cell.column || `Column ${index + 1}`}</strong></dt>
        <dd style={{ whiteSpace: "pre-wrap", marginLeft: 0 }}>{cell.value === "" ? <em>Blank in file</em> : cell.value}</dd>
      </div>)}
    </dl>}
  </details>;
}
