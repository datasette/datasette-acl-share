import { describe, expect, it } from "vitest";
import { avatarColor, initials, kindBadge } from "./avatar";

describe("initials", () => {
  it("uses first+last initials for multi-word names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  jean luc  picard ")).toBe("JP");
  });
  it("uses a single letter for one-word names/ids", () => {
    expect(initials("alice")).toBe("A");
  });
  it("splits on separators", () => {
    expect(initials("ada.lovelace")).toBe("AL");
    expect(initials("ada_lovelace")).toBe("AL");
    expect(initials("ada-lovelace")).toBe("AL");
  });
  it("falls back to ? for empty/missing", () => {
    expect(initials("")).toBe("?");
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
  });
});

describe("avatarColor", () => {
  it("is deterministic for a key", () => {
    expect(avatarColor("alice")).toBe(avatarColor("alice"));
  });
  it("returns a hex colour", () => {
    expect(avatarColor("bob")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("kindBadge", () => {
  it("returns null for users", () => {
    expect(kindBadge("user")).toBeNull();
  });
  it("returns a glyph for group/agent/public", () => {
    expect(kindBadge("group")).toBeTruthy();
    expect(kindBadge("agent")).toBeTruthy();
    expect(kindBadge("public")).toBeTruthy();
  });
});
