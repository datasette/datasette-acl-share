import { describe, expect, it } from "vitest";
import {
  currentWildcardGrant,
  defaultPickerRole,
  GENERAL_ACCESS_PRINCIPALS,
  generalAccessRoles,
  isOwnerGrant,
  isWildcardGrant,
  orderGrants,
  selectableRoles,
} from "./grants";
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

describe("general-access helpers", () => {
  it("offers BOTH wildcard principals (* and _signed_in)", () => {
    expect(GENERAL_ACCESS_PRINCIPALS).toEqual(["*", "_signed_in"]);
  });

  it("isWildcardGrant matches public kind and wildcard ids", () => {
    expect(isWildcardGrant(grant({ id: "*", kind: "public" }))).toBe(true);
    expect(isWildcardGrant(grant({ id: "_signed_in", kind: "public" }))).toBe(true);
    // Even if kind wasn't enriched, the id is recognised.
    expect(isWildcardGrant(grant({ id: "*", kind: "user" }))).toBe(true);
    expect(isWildcardGrant(grant({ id: "alice", kind: "user" }))).toBe(false);
  });

  it("currentWildcardGrant returns the public grant or null", () => {
    const grants: Grant[] = [
      grant({ id: "alice", role: "Editor", kind: "user" }),
      grant({ id: "_signed_in", role: "Viewer", kind: "public" }),
    ];
    expect(currentWildcardGrant(grants)?.id).toBe("_signed_in");
    expect(currentWildcardGrant([grant({ id: "bob", kind: "user" })])).toBeNull();
  });

  it("generalAccessRoles excludes manage roles and Owner", () => {
    expect(generalAccessRoles(ROLES).map((r) => r.name)).toEqual([
      "Viewer",
      "Editor",
    ]);
  });
});

describe("defaultPickerRole", () => {
  it("prefers the lowest-rank write role (Editor)", () => {
    expect(defaultPickerRole(ROLES)).toBe("Editor");
  });
  it("falls back to the lowest selectable role when no write role", () => {
    const readOnly: Role[] = [
      { name: "Viewer", actions: ["read"], rank: 10 },
      { name: "Lister", actions: ["list"], rank: 5 },
    ];
    expect(defaultPickerRole(readOnly)).toBe("Lister");
  });
  it("returns null when there are no selectable roles", () => {
    expect(defaultPickerRole([{ name: "Owner", actions: ["*"], rank: 1 }])).toBeNull();
  });
});
