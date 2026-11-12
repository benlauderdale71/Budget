import { partitionQueue, withStableOpId, type QueuedOp } from "./queue.js";

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.name = "ApiError";
  }
}

const QUEUE = "budgetcents.queue";
const OWNER = "budgetcents.userId";

function readQueue(): QueuedOp[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE) || "[]") as QueuedOp[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedOp[]) {
  localStorage.setItem(QUEUE, JSON.stringify(queue.slice(-40)));
  window.dispatchEvent(new Event("budgetcents-queue"));
}

export function setQueueOwner(userId: string | null) {
  if (userId) localStorage.setItem(OWNER, userId);
  else localStorage.removeItem(OWNER);
}

export function clearLocalSession() {
  localStorage.removeItem("budgetcents.token");
  localStorage.removeItem("budgetcents.household");
  localStorage.removeItem("budgetcents.profile");
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("budgetcents.cache.")) localStorage.removeItem(key);
  }
  setQueueOwner(null);
}

function currentOwner(): string | null {
  return localStorage.getItem(OWNER);
}

function remember(path: string, method: string, body: string | undefined, opId?: string) {
  const ownerId = currentOwner();
  const plan = path.includes("/assignments") || path.endsWith("/move");
  const txn = path.includes("/transactions");
  if (!ownerId || method === "GET" || (!plan && !txn)) return false;
  const queue = readQueue();
  if (opId && queue.some((item) => item.opId === opId && item.ownerId === ownerId && item.path === path)) return plan ? "plan" : "transaction";
  queue.push({ path, method, body, at: Date.now(), ownerId, opId });
  writeQueue(queue);
  return plan ? "plan" : "transaction";
}

export function queuedCount(): number {
  const ownerId = currentOwner();
  return readQueue().filter((item) => ownerId && item.ownerId === ownerId).length;
}

export async function flushQueue(): Promise<{ sent: number; rejected: string }> {
  const token = localStorage.getItem("budgetcents.token");
  const ownerId = currentOwner();
  const queue = readQueue();
  if (!token || !ownerId) return { sent: 0, rejected: "" };
  const { send, keep } = partitionQueue(queue, ownerId);
  const left: QueuedOp[] = [...keep];
  let sent = 0;
  let rejected = "";
  for (const item of send) {
    try {
      await api(item.path, { method: item.method, body: item.body }, { queue: false });
      sent += 1;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 0 || error.status === 401 || error.status >= 500)) left.push(item);
      else if (error instanceof ApiError) rejected = error.message;
      else left.push(item);
    }
  }
  writeQueue(left);
  return { sent, rejected };
}

export async function api<T>(path: string, init: RequestInit = {}, options: { queue?: boolean } = {}): Promise<T> {
  const token = localStorage.getItem("budgetcents.token");
  const method = (init.method ?? "GET").toUpperCase();
  const stamped = typeof init.body === "string" ? withStableOpId(path, method, init.body, () => crypto.randomUUID()) : { body: undefined as string | undefined };
  const body = typeof init.body === "string" ? stamped.body : init.body;
  const headers = new Headers(init.headers);
  if (body && typeof body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(path, { ...init, method, body, headers });
  } catch {
    const kept = options.queue !== false && remember(path, method, typeof body === "string" ? body : undefined, stamped.opId);
    throw new ApiError(0, kept === "plan"
      ? "You are offline. This assignment is waiting on this device. It is not on the plan until the server accepts it."
      : kept === "transaction"
        ? "You are offline. This transaction stays on this device and will send when the connection returns. It is not saved until the server accepts it."
        : "You are offline. This change was not saved.");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    const kept = options.queue !== false && remember(path, method, typeof body === "string" ? body : undefined, stamped.opId);
    throw new ApiError(0, kept
      ? "The server did not finish answering. This change is waiting on this device. It is not saved until the server accepts it."
      : "The server did not finish answering. This change was not saved.");
  }
  let data: { error?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (response.status === 401) {
    clearLocalSession();
    window.dispatchEvent(new Event("budgetcents-unauthorized"));
    throw new ApiError(401, data?.error ?? "Sign in again.");
  }
  if (!response.ok) {
    if ((response.status === 403 || response.status === 404) && path.startsWith("/api/households/")) {
      window.dispatchEvent(new Event("budgetcents-access"));
    }
    throw new ApiError(response.status, data?.error ?? "The request failed.", data);
  }
  return data as T;
}

export async function downloadFile(path: string, filename: string) {
  const token = localStorage.getItem("budgetcents.token");
  const response = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new ApiError(response.status, "The file could not be downloaded.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
