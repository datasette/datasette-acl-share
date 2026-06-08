import { describe, it, expect, vi } from "vitest";
import {
  ShareApi,
  ShareApiError,
  capabilitiesFromFeatures,
} from "./api";

/** Build a fake `fetch` returning a JSON body with the given status. */
function jsonFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

describe("ShareApi.getResource", () => {
  it("GETs the resource URL with same-origin credentials", async () => {
    const fetchMock = jsonFetch({
      resource_type: "paper-doc",
      parent: "mydb",
      child: "42",
      can_manage: true,
      roles: [],
      grants: [],
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const state = await api.getResource("paper-doc", "mydb", "42");
    expect(state.can_manage).toBe(true);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/-/acl/api/resource/paper-doc/mydb/42");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });

  it("omits the child segment when child is null/empty", async () => {
    const fetchMock = jsonFetch({
      resource_type: "t",
      parent: "p",
      child: null,
      can_manage: false,
      roles: [],
      grants: [],
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.getResource("t", "p", null);
    expect(lastCall(fetchMock)[0]).toBe("/-/acl/api/resource/t/p");
  });

  it("url-encodes path segments", async () => {
    const fetchMock = jsonFetch({
      resource_type: "t",
      parent: "a/b",
      child: "c d",
      can_manage: false,
      roles: [],
      grants: [],
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.getResource("t", "a/b", "c d");
    expect(lastCall(fetchMock)[0]).toBe("/-/acl/api/resource/t/a%2Fb/c%20d");
  });

  it("respects a custom aclBase", async () => {
    const fetchMock = jsonFetch({
      resource_type: "t",
      parent: "p",
      child: null,
      can_manage: false,
      roles: [],
      grants: [],
    });
    const api = new ShareApi({
      aclBase: "/custom/acl",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.getResource("t", "p");
    expect(lastCall(fetchMock)[0]).toBe("/custom/acl/resource/t/p");
  });
});

describe("ShareApi mutations", () => {
  it("grant POSTs JSON with Content-Type and parses the grant", async () => {
    const grant = {
      principal: "actor",
      id: "alice",
      role: "Editor",
      actions: ["paper-edit"],
      kind: "user",
    };
    const fetchMock = jsonFetch({ ok: true, grant });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const result = await api.grant("paper-doc", "mydb", "42", {
      actor_id: "alice",
      role: "Editor",
    });
    expect(result.id).toBe("alice");
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/-/acl/api/resource/paper-doc/mydb/42/grant");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({
      actor_id: "alice",
      role: "Editor",
    });
  });

  it("forwards the x-csrftoken header on writes when supplied", async () => {
    const fetchMock = jsonFetch({ ok: true, grant: { principal: "actor", id: "x", role: null, actions: [], kind: "user" } });
    const api = new ShareApi({
      csrftoken: "tok-123",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.grant("t", "p", null, { actor_id: "x" });
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers["x-csrftoken"]).toBe("tok-123");
  });

  it("does NOT send x-csrftoken when no token is configured", async () => {
    const fetchMock = jsonFetch({ ok: true, grant: { principal: "actor", id: "x", role: null, actions: [], kind: "user" } });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.grant("t", "p", null, { actor_id: "x" });
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers["x-csrftoken"]).toBeUndefined();
  });

  it("never sends a csrftoken on GET requests", async () => {
    const fetchMock = jsonFetch({ groups: [] });
    const api = new ShareApi({
      csrftoken: "tok-123",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.listGroups();
    const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
    expect(headers["x-csrftoken"]).toBeUndefined();
    expect(lastCall(fetchMock)[1].method).toBe("GET");
  });

  it("update POSTs to the update endpoint", async () => {
    const fetchMock = jsonFetch({
      ok: true,
      grant: { principal: "actor", id: "alice", role: "Viewer", actions: [], kind: "user" },
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.update("paper-doc", "mydb", "42", { actor_id: "alice", role: "Viewer" });
    expect(lastCall(fetchMock)[0]).toBe("/-/acl/api/resource/paper-doc/mydb/42/update");
  });

  it("revoke POSTs the principal and returns the removed action names", async () => {
    const fetchMock = jsonFetch({ ok: true, removed: ["doc-edit", "doc-view"] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const removed = await api.revoke("paper-doc", "mydb", "42", { actor_id: "alice" });
    expect(removed).toEqual(["doc-edit", "doc-view"]);
    expect(lastCall(fetchMock)[0]).toBe("/-/acl/api/resource/paper-doc/mydb/42/revoke");
    expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({ actor_id: "alice" });
  });

  it("revoke returns [] when the principal held no grants", async () => {
    const fetchMock = jsonFetch({ ok: true, removed: [] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const removed = await api.revoke("t", "p", null, { actor_id: "nobody" });
    expect(removed).toEqual([]);
  });

  it("revoke supports group principals", async () => {
    const fetchMock = jsonFetch({ ok: true, removed: ["t-view"] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.revoke("t", "p", null, { group_id: 7 });
    expect(JSON.parse(lastCall(fetchMock)[1].body as string)).toEqual({ group_id: 7 });
  });
});

describe("ShareApi pickers", () => {
  it("searchPeople hits the profiles search endpoint with q", async () => {
    const fetchMock = jsonFetch({
      results: [{ id: "alice", display_name: "Alice", kind: "user", avatar_url: "/-/profile/pic/alice" }],
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const people = await api.searchPeople("ali");
    expect(people).toHaveLength(1);
    expect(people[0]?.id).toBe("alice");
    expect(lastCall(fetchMock)[0]).toBe("/-/profiles/api/search?q=ali");
  });

  it("searchPeople omits an empty q from the query string", async () => {
    const fetchMock = jsonFetch({ results: [] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.searchPeople("");
    expect(lastCall(fetchMock)[0]).toBe("/-/profiles/api/search");
  });

  it("listAgents hits the agent identities endpoint", async () => {
    const fetchMock = jsonFetch({ results: [{ id: "bot", kind: "agent", avatar_url: "" }] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const agents = await api.listAgents("bo");
    expect(agents[0]?.kind).toBe("agent");
    expect(lastCall(fetchMock)[0]).toBe("/-/agent/api/identities?q=bo");
  });

  it("listGroups hits the acl groups endpoint", async () => {
    const fetchMock = jsonFetch({ groups: [{ id: 1, name: "team", member_count: 4 }] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const groups = await api.listGroups();
    expect(groups[0]?.name).toBe("team");
    expect(lastCall(fetchMock)[0]).toBe("/-/acl/api/groups");
  });
});

describe("ShareApi pickers carry the resource for per-resource authz", () => {
  it("listGroups appends resource_type/parent/child", async () => {
    const fetchMock = jsonFetch({ groups: [] });
    const api = new ShareApi({
      resource: { resourceType: "paper-doc", parent: "_paper", child: "42" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.listGroups();
    expect(lastCall(fetchMock)[0]).toBe(
      "/-/acl/api/groups?resource_type=paper-doc&parent=_paper&child=42",
    );
  });

  it("searchPeople appends the resource alongside q", async () => {
    const fetchMock = jsonFetch({ results: [] });
    const api = new ShareApi({
      resource: { resourceType: "paper-doc", parent: "_paper", child: "42" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.searchPeople("lois");
    expect(lastCall(fetchMock)[0]).toBe(
      "/-/profiles/api/search?q=lois&resource_type=paper-doc&parent=_paper&child=42",
    );
  });

  it("listAgents appends the resource alongside q", async () => {
    const fetchMock = jsonFetch({ results: [] });
    const api = new ShareApi({
      resource: { resourceType: "paper-doc", parent: "_paper", child: "42" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.listAgents("bot");
    expect(lastCall(fetchMock)[0]).toBe(
      "/-/agent/api/identities?q=bot&resource_type=paper-doc&parent=_paper&child=42",
    );
  });

  it("omits an empty child segment from picker params", async () => {
    const fetchMock = jsonFetch({ groups: [] });
    const api = new ShareApi({
      resource: { resourceType: "paper-doc", parent: "_paper", child: null },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await api.listGroups();
    expect(lastCall(fetchMock)[0]).toBe(
      "/-/acl/api/groups?resource_type=paper-doc&parent=_paper",
    );
  });

  it("omits resource params entirely when no resource is supplied", async () => {
    const fetchMock = jsonFetch({ groups: [] });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.listGroups();
    expect(lastCall(fetchMock)[0]).toBe("/-/acl/api/groups");
  });
});

describe("error handling", () => {
  it("non-2xx surfaces a ShareApiError carrying status + server message", async () => {
    const fetchMock = jsonFetch({ ok: false, error: "Cannot manage sharing for this resource" }, 403);
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    await expect(api.getResource("t", "p")).rejects.toMatchObject({
      name: "ShareApiError",
      status: 403,
      message: "Cannot manage sharing for this resource",
    });
  });

  it("network/transport failure becomes a status-0 ShareApiError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const err = await api.getResource("t", "p").catch((e) => e);
    expect(err).toBeInstanceOf(ShareApiError);
    expect((err as ShareApiError).status).toBe(0);
  });
});

describe("capability detection", () => {
  it("probeCapabilities marks a 404 agent backend as absent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/-/agent/api/identities")) {
        return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const caps = await api.probeCapabilities();
    expect(caps.agents).toBe(false);
    expect(caps.people).toBe(true);
    expect(caps.groups).toBe(true);
    expect(caps.public).toBe(true);
  });

  it("probeCapabilities keeps a 403-restricted backend enabled", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/-/profiles/api/search")) {
        return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const api = new ShareApi({ fetch: fetchMock as unknown as typeof fetch });
    const caps = await api.probeCapabilities();
    expect(caps.people).toBe(true);
  });
});

describe("capabilitiesFromFeatures", () => {
  it("enables everything when features is missing/empty", () => {
    expect(capabilitiesFromFeatures(undefined)).toEqual({
      people: true,
      agents: true,
      groups: true,
      public: true,
    });
    expect(capabilitiesFromFeatures("")).toEqual({
      people: true,
      agents: true,
      groups: true,
      public: true,
    });
  });

  it("parses a comma-separated subset", () => {
    expect(capabilitiesFromFeatures("people, groups")).toEqual({
      people: true,
      agents: false,
      groups: true,
      public: false,
    });
  });
});
