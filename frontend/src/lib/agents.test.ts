import { describe, expect, it } from "vitest";
import { agentLabel, filterAgents, normalizeAgents } from "./agents";
import type { Actor, Grant } from "./types";

function actor(partial: Partial<Actor> & Pick<Actor, "id">): Actor {
  return { kind: "agent", ...partial };
}
function grant(partial: Partial<Grant> & Pick<Grant, "id">): Grant {
  return { principal: "actor", role: null, actions: [], kind: "agent", ...partial };
}

describe("agentLabel", () => {
  it("prefers display_name, falls back to id", () => {
    expect(agentLabel(actor({ id: "researcher", display_name: "Researcher" }))).toBe(
      "Researcher",
    );
    expect(agentLabel(actor({ id: "bot" }))).toBe("bot");
  });
});

describe("normalizeAgents", () => {
  it("forces kind:'agent' when missing", () => {
    const out = normalizeAgents([{ id: "x" } as Actor]);
    expect(out[0]?.kind).toBe("agent");
  });
});

describe("filterAgents", () => {
  it("drops agents already granted (actor principal space)", () => {
    const results = [actor({ id: "a" }), actor({ id: "b" })];
    const grants = [grant({ id: "a" })];
    expect(filterAgents(results, grants).map((a) => a.id)).toEqual(["b"]);
  });
});
