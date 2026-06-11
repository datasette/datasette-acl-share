import { describe, expect, it } from "vitest";
import {
  addPill,
  batchGrantRequests,
  blockingGrant,
  hasPill,
  pillFromActor,
  pillFromGroup,
  pillKey,
  pillPrincipal,
  removePill,
  type Pill,
} from "./pills";
import type { Actor, Grant, Group } from "./types";

function grant(partial: Partial<Grant> & Pick<Grant, "principal" | "id">): Grant {
  return { role: null, actions: [], kind: "user", ...partial };
}

const ALICE: Pill = { principal: "actor", id: "alice", label: "Alice", kind: "user" };
const BOB: Pill = { principal: "actor", id: "bob", label: "Bob", kind: "user" };
const TEAM: Pill = { principal: "group", id: "7", label: "Team", kind: "group" };

describe("pillKey", () => {
  it("keys by principal + id and matches grant keying", () => {
    expect(pillKey(ALICE)).toBe("actor:alice");
    expect(pillKey(TEAM)).toBe("group:7");
    // An actor and a group with the same id are distinct.
    expect(pillKey({ principal: "actor", id: "7" })).not.toBe(pillKey(TEAM));
  });
});

describe("pillFromActor", () => {
  it("builds an actor pill with the display-name label", () => {
    const actor: Actor = {
      id: "carol",
      display_name: "Carol Smith",
      email: "c@x.com",
      kind: "user",
      avatar_url: "/pic/carol",
    };
    expect(pillFromActor(actor)).toEqual({
      principal: "actor",
      id: "carol",
      label: "Carol Smith",
      kind: "user",
      avatar_url: "/pic/carol",
      email: "c@x.com",
    });
  });

  it("falls back to email then id for the label", () => {
    expect(pillFromActor({ id: "x", email: "x@y.com", kind: "user" }).label).toBe(
      "x@y.com",
    );
    expect(pillFromActor({ id: "x", kind: "user" }).label).toBe("x");
  });
});

describe("pillFromGroup", () => {
  it("builds a group pill with a stringified id", () => {
    const group: Group = { id: 7, name: "Team", member_count: 4 };
    expect(pillFromGroup(group)).toEqual({
      principal: "group",
      id: "7",
      label: "Team",
      kind: "group",
      member_count: 4,
    });
  });
});

describe("hasPill / addPill / removePill", () => {
  it("addPill appends and de-dupes by principal", () => {
    const a = addPill([], ALICE);
    expect(a).toEqual([ALICE]);
    const b = addPill(a, BOB);
    expect(b.map((p) => p.id)).toEqual(["alice", "bob"]);
    // Adding alice again is a no-op (and returns the same array reference).
    const c = addPill(b, { ...ALICE, label: "Alice (dupe)" });
    expect(c).toBe(b);
    expect(c).toHaveLength(2);
  });

  it("does not collapse an actor and a group with the same id", () => {
    const actor7: Pill = { principal: "actor", id: "7", label: "Seven", kind: "user" };
    const pills = addPill(addPill([], TEAM), actor7);
    expect(pills).toHaveLength(2);
  });

  it("hasPill reports membership by principal", () => {
    expect(hasPill([ALICE], ALICE)).toBe(true);
    expect(hasPill([ALICE], BOB)).toBe(false);
  });

  it("removePill removes by principal key and leaves others", () => {
    const pills = [ALICE, BOB, TEAM];
    expect(removePill(pills, ALICE).map((p) => p.id)).toEqual(["bob", "7"]);
    expect(removePill(pills, TEAM).map((p) => p.id)).toEqual(["alice", "bob"]);
    // Removing something absent is a no-op (new array, same contents).
    expect(removePill(pills, { principal: "actor", id: "nope" })).toEqual(pills);
  });
});

describe("pillPrincipal", () => {
  it("maps actor and group pills to grant principals", () => {
    // Actor pills come from the people picker, so they pin
    // principal_type:"actor" — never inferred as a wildcard.
    expect(pillPrincipal(ALICE)).toEqual({
      actor_id: "alice",
      principal_type: "actor",
    });
    expect(pillPrincipal(TEAM)).toEqual({ group_id: "7" });
  });
});

describe("batchGrantRequests", () => {
  it("builds one request per pill at the given role, in order", () => {
    expect(batchGrantRequests([ALICE, TEAM], "Editor")).toEqual([
      { actor_id: "alice", principal_type: "actor", role: "Editor" },
      { group_id: "7", role: "Editor" },
    ]);
  });
  it("returns an empty array for no pills", () => {
    expect(batchGrantRequests([], "Editor")).toEqual([]);
  });
});

describe("blockingGrant", () => {
  it("returns the matching existing grant for actor and group pills", () => {
    const grants = [grant({ principal: "actor", id: "bob" }), grant({ principal: "group", id: "7", kind: "group" })];
    expect(blockingGrant(grants, BOB)?.id).toBe("bob");
    expect(blockingGrant(grants, TEAM)?.id).toBe("7");
  });
  it("returns null when no grant matches", () => {
    expect(blockingGrant([], ALICE)).toBeNull();
    // Same id, different principal type → not a match.
    const grants = [grant({ principal: "group", id: "alice", kind: "group" })];
    expect(blockingGrant(grants, ALICE)).toBeNull();
  });
});
