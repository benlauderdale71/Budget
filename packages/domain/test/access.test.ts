import { describe, expect, it } from "vitest";
import { allows, capabilityLines, effectiveMemberLimit, INVITE_ROLES, safeReturnPath, serverMemberLimit } from "../src/access.js";

describe("household access", () => {
  it("keeps read-only and professional roles from changing money", () => {
    for (const role of ["readonly", "coach", "planner", "accountant"]) {
      expect(allows(role, "finance")).toBe(false);
      expect(allows(role, "plan")).toBe(false);
      expect(allows(role, "invite")).toBe(false);
      expect(allows(role, "transfer")).toBe(false);
      expect(allows(role, "comment")).toBe(true);
    }
    expect(allows("readonly", "review")).toBe(false);
    for (const role of ["coach", "planner", "accountant", "contributor", "editor", "admin", "owner"]) {
      expect(allows(role, "review")).toBe(true);
    }
    expect(allows("contributor", "finance")).toBe(true);
    expect(allows("contributor", "plan")).toBe(false);
    expect(allows("editor", "plan")).toBe(true);
    expect(allows("admin", "transfer")).toBe(false);
    expect(allows("owner", "transfer")).toBe(true);
    expect(allows("guest", "comment")).toBe(false);
    expect(INVITE_ROLES).not.toContain("owner");
    expect(capabilityLines("coach").join(" ")).toMatch(/does not change the amount/);
  });

  it("uses 12 unless a server or household limit is configured inside the allowed range", () => {
    expect(serverMemberLimit(undefined)).toBe(12);
    expect(serverMemberLimit("20")).toBe(20);
    expect(() => serverMemberLimit("5")).toThrow(/6 to 100/);
    expect(() => serverMemberLimit("nope")).toThrow(/6 to 100/);
    expect(effectiveMemberLimit(undefined, null)).toBe(12);
    expect(effectiveMemberLimit("20", 8)).toBe(8);
    expect(effectiveMemberLimit("12", 50)).toBe(12);
    expect(effectiveMemberLimit("12", 3)).toBe(12);
  });

  it("rejects a return path that leaves this site", () => {
    expect(safeReturnPath("/invite/abc")).toBe("/invite/abc");
    expect(safeReturnPath(" /household ")).toBe("/household");
    expect(safeReturnPath("https://evil.example/invite")).toBeNull();
    expect(safeReturnPath("//evil.example")).toBeNull();
    expect(safeReturnPath("/\\evil")).toBeNull();
    expect(safeReturnPath("/%2F%2Fevil.example")).toBeNull();
    expect(safeReturnPath("/invite/../settings")).toBeNull();
    expect(safeReturnPath("")).toBeNull();
  });
});
