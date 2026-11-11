export const ROLES = ["owner", "admin", "editor", "contributor", "readonly", "coach", "planner", "accountant"] as const;
export type Role = (typeof ROLES)[number];
export const INVITE_ROLES = ["admin", "editor", "contributor", "readonly", "coach", "planner", "accountant"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const DEFAULT_MEMBER_LIMIT = 12;
export const MIN_MEMBER_LIMIT = 6;
export const MAX_MEMBER_LIMIT = 100;

export type Capability = "finance" | "plan" | "comment" | "review" | "invite" | "transfer";

const FINANCE: readonly Role[] = ["owner", "admin", "editor", "contributor"];
const PLAN: readonly Role[] = ["owner", "admin", "editor"];
const REVIEW: readonly Role[] = ["owner", "admin", "editor", "contributor", "coach", "planner", "accountant"];
const INVITE: readonly Role[] = ["owner", "admin"];

export function isRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

export function isInviteRole(role: string): role is InviteRole {
  return (INVITE_ROLES as readonly string[]).includes(role);
}

export function allows(role: string, capability: Capability): boolean {
  if (!isRole(role)) return false;
  if (capability === "finance") return FINANCE.includes(role);
  if (capability === "plan") return PLAN.includes(role);
  if (capability === "comment") return true;
  if (capability === "review") return REVIEW.includes(role);
  if (capability === "invite") return INVITE.includes(role);
  return role === "owner";
}

export function roleLabel(role: string): string {
  if (role === "readonly") return "Read-only";
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "editor") return "Editor";
  if (role === "contributor") return "Contributor";
  if (role === "coach") return "Coach";
  if (role === "planner") return "Planner";
  if (role === "accountant") return "Accountant";
  return "Member";
}

export function capabilityLines(role: string): string[] {
  if (!isRole(role)) return ["This role cannot be granted."];
  const lines = [
    "View shared accounts, the plan, reports, and activity.",
    "Save your own dashboard, privacy mode, and security settings.",
    "Comment on a shared transaction. A comment does not change the amount, category, or balance.",
  ];
  if (allows(role, "review")) lines.push("Mark a shared transaction for review without changing the money.");
  else lines.push("Cannot mark transactions reviewed.");
  if (allows(role, "finance")) lines.push("Record and edit shared transactions.");
  else lines.push("Cannot add, edit, import, or delete household financial records.");
  if (allows(role, "plan")) lines.push("Change the shared plan, categories, bills, and goals.");
  else lines.push("Cannot change the shared plan.");
  if (allows(role, "invite")) lines.push("Invite people and change membership, except transferring ownership.");
  else lines.push("Cannot invite people or change someone else's role.");
  if (allows(role, "transfer")) lines.push("Transfer ownership.");
  else lines.push("Cannot transfer ownership or become the owner.");
  lines.push("Private accounts and personal spaces stay with their owners.");
  return lines;
}

export function invitationDisclosure(householdName: string, role: string): { summary: string; sharedRecords: string; privateRecords: string } {
  return {
    summary: `You will see shared spaces and shared accounts in ${householdName}. Private accounts and personal spaces stay with their owners. Role: ${roleLabel(role)}.`,
    sharedRecords: "After you accept, shared records in this household become visible to you.",
    privateRecords: "Private accounts and personal spaces stay restricted. This preview does not include balances, transactions, or anyone else's email address.",
  };
}

export function serverMemberLimit(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_MEMBER_LIMIT;
  if (!/^\d+$/.test(raw.trim())) throw new Error("BUDGETCENTS_MEMBER_LIMIT must be a whole number from 6 to 100.");
  const value = Number(raw);
  if (value < MIN_MEMBER_LIMIT || value > MAX_MEMBER_LIMIT) throw new Error("BUDGETCENTS_MEMBER_LIMIT must be a whole number from 6 to 100.");
  return value;
}

export function effectiveMemberLimit(serverRaw: string | undefined, householdLimit: number | null): number {
  const server = serverMemberLimit(serverRaw);
  if (householdLimit == null) return server;
  if (!Number.isInteger(householdLimit) || householdLimit < MIN_MEMBER_LIMIT || householdLimit > server) return server;
  return householdLimit;
}

export function safeReturnPath(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return null;
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.startsWith("/\\")) return null;
  if (decoded.includes("\\") || decoded.includes("://") || decoded.includes("\0")) return null;
  if (decoded.split("/").some((part) => part === ".." || part === ".")) return null;
  return decoded;
}
