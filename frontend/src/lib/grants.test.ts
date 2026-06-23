import { describe, expect, it } from "vitest";
import {
  ADDABLE_AUDIENCES,
  audienceLabel,
  availableAudiencesToAdd,
  defaultPickerRole,
  defaultPublicRole,
  generalAccessRoles,
  isLastManageGrant,
  isManageGrant,
  isOwnerGrant,
  isWildcardGrant,
  orderGrants,
  publicGrants,
  PUBLIC_AUDIENCES,
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

describe("isManageGrant", () => {
  it("is true for the Owner row and any manage-capable role", () => {
    expect(isManageGrant(grant({ id: "a", role: "Owner" }), ROLES)).toBe(true);
    expect(isManageGrant(grant({ id: "a", role: "Manager" }), ROLES)).toBe(true);
    expect(isManageGrant(grant({ id: "a", is_owner: true, role: "Editor" }), ROLES)).toBe(true);
  });
  it("is false for non-manage roles and unknown/null roles", () => {
    expect(isManageGrant(grant({ id: "a", role: "Editor" }), ROLES)).toBe(false);
    expect(isManageGrant(grant({ id: "a", role: "Viewer" }), ROLES)).toBe(false);
    expect(isManageGrant(grant({ id: "a", role: null }), ROLES)).toBe(false);
    expect(isManageGrant(grant({ id: "a", role: "Nope" }), ROLES)).toBe(false);
  });
});

describe("isLastManageGrant", () => {
  it("flags the sole manager (orphan guard) — across actors, groups and owner", () => {
    const grants: Grant[] = [
      grant({ id: "me", role: "Manager" }),
      grant({ id: "v", role: "Viewer" }),
      grant({ id: "e", role: "Editor" }),
    ];
    expect(isLastManageGrant(grants[0]!, grants, ROLES)).toBe(true);
  });

  it("is false when another manage-capable grant exists", () => {
    const grants: Grant[] = [
      grant({ id: "me", role: "Manager" }),
      grant({ id: "owner", role: "Owner" }),
    ];
    expect(isLastManageGrant(grants[0]!, grants, ROLES)).toBe(false);
  });

  it("counts a managing group as another manager", () => {
    const grants: Grant[] = [
      grant({ id: "me", role: "Manager" }),
      grant({ id: "5", principal: "group", kind: "group", role: "Manager" }),
    ];
    expect(isLastManageGrant(grants[0]!, grants, ROLES)).toBe(false);
  });

  it("is false for a non-manage grant (always safe to remove)", () => {
    const grants: Grant[] = [
      grant({ id: "me", role: "Manager" }),
      grant({ id: "v", role: "Viewer" }),
    ];
    expect(isLastManageGrant(grants[1]!, grants, ROLES)).toBe(false);
  });

  it("does not confuse a like-named actor/group as the same principal", () => {
    // Same id, different principal — both manage; removing one leaves the other.
    const grants: Grant[] = [
      grant({ id: "1", principal: "actor", role: "Manager" }),
      grant({ id: "1", principal: "group", kind: "group", role: "Manager" }),
    ];
    expect(isLastManageGrant(grants[0]!, grants, ROLES)).toBe(false);
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
  it("knows all three audiences but only offers the two disjoint ones to add", () => {
    expect(PUBLIC_AUDIENCES).toEqual(["everyone", "authenticated", "anonymous"]);
    // `everyone` overlaps the other two, so it is never offered as a NEW choice.
    expect(ADDABLE_AUDIENCES).toEqual(["authenticated", "anonymous"]);
    expect(ADDABLE_AUDIENCES).not.toContain("everyone");
  });

  it("isWildcardGrant matches on public kind only", () => {
    expect(isWildcardGrant(grant({ id: "everyone", kind: "public" }))).toBe(true);
    expect(isWildcardGrant(grant({ id: "authenticated", kind: "public" }))).toBe(true);
    // A real user whose id collides with an audience name (principal_type
    // "actor", so kind "user") belongs in the people roster, not General access.
    expect(isWildcardGrant(grant({ id: "everyone", kind: "user" }))).toBe(false);
    expect(isWildcardGrant(grant({ id: "alice", kind: "user" }))).toBe(false);
  });

  it("publicGrants returns every public grant, most-permissive first", () => {
    const grants: Grant[] = [
      grant({ id: "anonymous", role: "Viewer", kind: "public" }),
      grant({ id: "alice", role: "Editor", kind: "user" }),
      grant({ id: "everyone", role: "Viewer", kind: "public" }),
      grant({ id: "authenticated", role: "Editor", kind: "public" }),
    ];
    expect(publicGrants(grants).map((g) => g.id)).toEqual([
      "everyone",
      "authenticated",
      "anonymous",
    ]);
    expect(publicGrants([grant({ id: "bob", kind: "user" })])).toEqual([]);
  });

  it("availableAudiencesToAdd excludes everyone AND already-present audiences", () => {
    // Nothing present yet → both disjoint audiences offered.
    expect(availableAudiencesToAdd([])).toEqual(["authenticated", "anonymous"]);
    // authenticated already granted → only anonymous remains.
    expect(
      availableAudiencesToAdd([
        grant({ id: "authenticated", role: "Editor", kind: "public" }),
      ]),
    ).toEqual(["anonymous"]);
    // A pre-existing everyone grant doesn't consume an addable slot, but it also
    // never makes everyone addable.
    expect(
      availableAudiencesToAdd([grant({ id: "everyone", role: "Viewer", kind: "public" })]),
    ).toEqual(["authenticated", "anonymous"]);
  });

  it("audienceLabel maps each audience to a friendly label", () => {
    expect(audienceLabel("everyone")).toBe("Anyone");
    expect(audienceLabel("authenticated")).toBe("Anyone signed in");
    expect(audienceLabel("anonymous")).toBe("Anyone signed out");
  });

  it("generalAccessRoles excludes manage roles and Owner", () => {
    expect(generalAccessRoles(ROLES).map((r) => r.name)).toEqual([
      "Viewer",
      "Editor",
    ]);
  });

  it("defaultPublicRole picks the lowest-rank non-manage role (conservative)", () => {
    expect(defaultPublicRole(ROLES)).toBe("Viewer");
    // No selectable (non-manage) role → null.
    expect(defaultPublicRole([{ name: "Owner", actions: ["*"], rank: 1, manage: true }])).toBeNull();
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
