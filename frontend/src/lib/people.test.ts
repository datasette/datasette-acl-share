import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorLabel,
  debounce,
  existingActorGrant,
  filterAlreadyGranted,
} from "./people";
import type { Actor, Grant } from "./types";

function grant(partial: Partial<Grant> & Pick<Grant, "id">): Grant {
  return { principal: "actor", role: null, actions: [], kind: "user", ...partial };
}
function actor(partial: Partial<Actor> & Pick<Actor, "id">): Actor {
  return { kind: "user", ...partial };
}

describe("debounce", () => {
  afterEach(() => vi.useRealTimers());

  it("runs once after the quiet window with the latest args", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("cancel() drops a pending run", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("x");
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("filterAlreadyGranted", () => {
  it("drops actors who already have an actor grant", () => {
    const results = [actor({ id: "alice" }), actor({ id: "bob" })];
    const grants = [grant({ id: "alice", role: "Editor" })];
    expect(filterAlreadyGranted(results, grants).map((a) => a.id)).toEqual(["bob"]);
  });
  it("ignores group grants when deduping actors", () => {
    const results = [actor({ id: "7" })];
    const grants = [grant({ id: "7", principal: "group", kind: "group" })];
    expect(filterAlreadyGranted(results, grants).map((a) => a.id)).toEqual(["7"]);
  });
});

describe("existingActorGrant", () => {
  it("finds an actor grant by id", () => {
    const grants = [grant({ id: "alice", role: "Editor" })];
    expect(existingActorGrant(grants, "alice")?.id).toBe("alice");
    expect(existingActorGrant(grants, "bob")).toBeNull();
  });
});

describe("actorLabel", () => {
  it("prefers display_name, then email, then id", () => {
    expect(actorLabel(actor({ id: "a", display_name: "Ada" }))).toBe("Ada");
    expect(actorLabel(actor({ id: "a", email: "a@x.com" }))).toBe("a@x.com");
    expect(actorLabel(actor({ id: "a" }))).toBe("a");
  });
});
