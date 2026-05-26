import { describe, expect, it } from "vitest";
import {
  existingGroupGrant,
  filterGroups,
  groupIdStr,
  memberCountLabel,
} from "./groups";
import type { Grant, Group } from "./types";

function grant(partial: Partial<Grant> & Pick<Grant, "id">): Grant {
  return { principal: "group", role: null, actions: [], kind: "group", ...partial };
}
const GROUPS: Group[] = [
  { id: 1, name: "Staff", member_count: 5 },
  { id: 2, name: "Editors", member_count: 2 },
  { id: 3, name: "Admins", member_count: 1 },
];

describe("groupIdStr", () => {
  it("stringifies numeric and string ids", () => {
    expect(groupIdStr(7)).toBe("7");
    expect(groupIdStr("abc")).toBe("abc");
  });
});

describe("filterGroups", () => {
  it("filters by case-insensitive name substring", () => {
    expect(filterGroups(GROUPS, [], "edit").map((g) => g.name)).toEqual(["Editors"]);
    expect(filterGroups(GROUPS, [], "")).toHaveLength(3);
  });
  it("drops groups already granted (by stringified id)", () => {
    const grants = [grant({ id: "1" })];
    expect(filterGroups(GROUPS, grants, "").map((g) => g.id)).toEqual([2, 3]);
  });
});

describe("existingGroupGrant", () => {
  it("matches a group grant by stringified id", () => {
    const grants = [grant({ id: "2" })];
    expect(existingGroupGrant(grants, 2)?.id).toBe("2");
    expect(existingGroupGrant(grants, 9)).toBeNull();
  });
});

describe("memberCountLabel", () => {
  it("pluralizes correctly", () => {
    expect(memberCountLabel(1)).toBe("1 member");
    expect(memberCountLabel(0)).toBe("0 members");
    expect(memberCountLabel(4)).toBe("4 members");
  });
});
