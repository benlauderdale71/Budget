import { partitionQueue, withStableOpId, type QueuedOp } from "./queue.js";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
  setQueueOwner(null);
}

function currentOwner(): string | null {
  return localStorage.getItem(OWNER);
}

function remember(path: string, method: string, body: string | undefined, opId?: string) {
  const ownerId = currentOwner();
  if (!ownerId || method === "GET" || !path.includes("/transactions")) return;
  const queue = readQueue();
  if (opId && queue.some((item) => item.opId === opId && item.ownerId === ownerId && item.path === path)) return;
  queue.push({ path, method, body, at: Date.now(), ownerId, opId });
  writeQueue(queue);
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
    if (options.queue !== false) remember(path, method, typeof body === "string" ? body : undefined, stamped.opId);
    throw new ApiError(0, "You are offline. A transaction entry was kept on this device and will send when the connection returns.");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    if (options.queue !== false) remember(path, method, typeof body === "string" ? body : undefined, stamped.opId);
    throw new ApiError(0, "The server did not finish answering. The entry stays on this device and will be sent again.");
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
  if (!response.ok) throw new ApiError(response.status, data?.error ?? "The request failed.");
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
