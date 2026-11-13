export interface QueuedOp {
  path: string;
  method: string;
  body?: string;
  at: number;
  ownerId: string;
  opId?: string;
}

export function transactionPostPath(path: string): boolean {
  const bare = path.split("?")[0] ?? path;
  return /\/transactions\/?$/.test(bare);
}

/** Keep one operation id from the first attempt through every retry of the same body. */
export function withStableOpId(path: string, method: string, body: string | undefined, createId: () => string): { body?: string; opId?: string } {
  if (method.toUpperCase() !== "POST" || !transactionPostPath(path) || body == null) return { body };
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body };
    const record = parsed as Record<string, unknown>;
    const existing = typeof record.opId === "string" && record.opId ? record.opId : createId();
    record.opId = existing;
    return { body: JSON.stringify(record), opId: existing };
  } catch {
    return { body };
  }
}

/** Queued work for another signed-in user stays stored and is not sent. */
export function partitionQueue(items: QueuedOp[], ownerId: string | null): { send: QueuedOp[]; keep: QueuedOp[] } {
  if (!ownerId) return { send: [], keep: items };
  const send: QueuedOp[] = [];
  const keep: QueuedOp[] = [];
  for (const item of items) {
    if (item.ownerId && item.ownerId === ownerId) send.push(item);
    else keep.push(item);
  }
  return { send, keep };
}
