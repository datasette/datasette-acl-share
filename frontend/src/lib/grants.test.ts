import { describe, expect, it } from "vitest";
import { isOwnerGrant, orderGrants, selectableRoles } from "./grants";
import type { Grant, Role } from "./types";

function grant(partial: Partial<Grant> & Pick<Grant, "id">): Grant {
  return {
    principal: "actor",
    role: null,
    actions: [],
    kind: "user",
    ...partial,
  };
}

const ROLES: Role[] = [
  { name: "Viewer", actions: ["read"], rank: 10 },
  { name: "Editor", actions: ["read", "write"], rank: 20 },
  { name: "Manager", actions: ["read", "write", "manage"], rank: 30, manage: true },
  { name: "Owner", actions: ["*"], rank: 40, manage: true },
];

describe("isOwnerGrant", () => {
  it("honours an explicit is_owner flag", () => {
    expect(isOwnerGrant(grant({ id: "a", is_owner: true, role: "Editor" }))).toBe(true);
  });
  it("treats the Owner role as owner (case-insensitive)", () => {
    expect(isOwnerGrant(grant({ id: "a", role: "Owner" }))).toBe(true);
    expect(isOwnerGrant(grant({ id: "a", role: "owner" }))).toBe(true);
  });
  it("is false for other roles / null", () => {
    expect(isOwnerGrant(grant({ id: "a", role: "Editor" }))).toBe(false);
    expect(isOwnerGrant(grant({ id: "a", role: null }))).toBe(false);
  });
});

describe("selectableRoles", () => {
  it("orders by ascending rank and excludes Owner", () => {
    const names = selectableRoles(ROLES).map((r) => r.name);
    expect(names).toEqual(["Viewer", "Editor", "Manager"]);
  });
  it("does not mutate its input", () => {
    const copy = [...ROLES];
    selectableRoles(ROLES);
    expect(ROLES).toEqual(copy);
  });
});

describe("orderGrants", () => {
  it("puts the owner first, then descending rank, then label", () => {
    const grants: Grant[] = [
      grant({ id: "viewer", role: "Viewer" }),
      grant({ id: "owner", role: "Owner" }),
      grant({ id: "zeditor", role: "Editor" }),
      grant({ id: "aeditor", role: "Editor" }),
    ];
    const ordered = orderGrants(grants, ROLES, (g) => g.id);
    expect(ordered.map((g) => g.id)).toEqual([
      "owner",
      "aeditor",
      "zeditor",
      "viewer",
    ]);
  });
});
