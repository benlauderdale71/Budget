export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

const QUEUE = "budgetcents.queue";

interface Queued {
  path: string;
  method: string;
  body?: string;
  at: number;
}

function readQueue(): Queued[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE) || "[]") as Queued[];
  } catch {
    return [];
  }
}

function remember(path: string, init: RequestInit) {
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" || !path.includes("/transactions")) return;
  const queue = readQueue();
  queue.push({ path, method, body: typeof init.body === "string" ? init.body : undefined, at: Date.now() });
  localStorage.setItem(QUEUE, JSON.stringify(queue.slice(-40)));
}

export function queuedCount(): number {
  return readQueue().length;
}

export async function flushQueue(): Promise<number> {
  const queue = readQueue();
  if (!queue.length) return 0;
  const left: Queued[] = [];
  let sent = 0;
  for (const item of queue) {
    try {
      await api(item.path, { method: item.method, body: item.body });
      sent += 1;
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) left.push(item);
    }
  }
  localStorage.setItem(QUEUE, JSON.stringify(left));
  return sent;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("budgetcents.token");
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    remember(path, init);
    throw new ApiError(0, "You are offline. A transaction entry was kept on this device and will send when the connection returns.");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (response.status === 401) {
    localStorage.removeItem("budgetcents.token");
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
