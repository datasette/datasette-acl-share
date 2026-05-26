import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
// Importing the component registers the <datasette-share-dialog> custom element.
import "./ShareDialog.svelte";
import type { ShareState } from "./lib/types";

// --- fetch harness -------------------------------------------------------
//
// The component constructs its own ShareApi (no fetch injection), so we stub
// the global fetch and route by URL + method. Each handler returns a JSON
// Response; `calls` records what was sent so assertions can inspect mutations.

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

let handlers: { match: (url: string) => boolean; handle: Handler }[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function on(fragment: string, handle: Handler) {
  handlers.push({ match: (url) => url.includes(fragment), handle });
}

const STATE: ShareState = {
  resource_type: "paper-doc",
  parent: "mydb",
  child: "42",
  can_manage: true,
  roles: [
    { name: "Viewer", actions: ["read"], rank: 10 },
    { name: "Editor", actions: ["read", "write"], rank: 20 },
    { name: "Owner", actions: ["*"], rank: 40, manage: true },
  ],
  grants: [
    {
      principal: "actor",
      id: "alice",
      role: "Owner",
      actions: ["*"],
      kind: "user",
      display_name: "Alice Owner",
    },
    {
      principal: "actor",
      id: "bob",
      role: "Editor",
      actions: ["read", "write"],
      kind: "user",
      display_name: "Bob Editor",
      avatar_url: "/-/profiles/pic/bob",
    },
    {
      principal: "group",
      id: "7",
      role: "Viewer",
      actions: ["read"],
      kind: "group",
      display_name: "Team",
      member_count: 4,
    },
  ],
};

beforeEach(() => {
  handlers = [];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = undefined;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });
      const h = handlers.find((x) => x.match(url));
      if (h) return h.handle(url, init ?? {});
      return json({ error: `unhandled ${url}` }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll("datasette-share-dialog").forEach((n) => n.remove());
});

function mount(
  attrs: Record<string, string>,
): { el: HTMLElement; events: Record<string, CustomEvent[]> } {
  const el = document.createElement("datasette-share-dialog");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const events: Record<string, CustomEvent[]> = {};
  for (const type of ["share-updated", "share-revoked", "share-changed"]) {
    events[type] = [];
    el.addEventListener(type, (e) => events[type]!.push(e as CustomEvent));
  }
  document.body.appendChild(el);
  return { el, events };
}

const BASE_ATTRS = {
  "resource-type": "paper-doc",
  parent: "mydb",
  child: "42",
  "resource-label": "Q2 Planning",
  "actor-json": JSON.stringify({ id: "alice", kind: "user" }),
};

describe("<datasette-share-dialog> people-with-access list", () => {
  it("renders a row per grant with names, kind badges and roles", async () => {
    on("/resource/", () => json(STATE));
    mount(BASE_ATTRS);

    // Names render (owner first).
    await expect.element(page.getByText("Alice Owner")).toBeInTheDocument();
    await expect.element(page.getByText("Bob Editor")).toBeInTheDocument();
    await expect.element(page.getByText("Team")).toBeInTheDocument();

    // Owner row is read-only (an "Owner" tag, not a select).
    await expect.element(page.getByText("Owner", { exact: true })).toBeInTheDocument();

    // Group sub-label shows member count.
    await expect.element(page.getByText("4 members")).toBeInTheDocument();

    // The current actor (alice) is flagged.
    await expect.element(page.getByText("(you)")).toBeInTheDocument();

    // Non-owner rows expose a role <select> and a remove button.
    await expect
      .element(page.getByRole("combobox", { name: "Role for Bob Editor" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Remove Bob Editor" }))
      .toBeInTheDocument();
  });

  it("changing a role dropdown calls update and emits share-updated", async () => {
    on("/resource/paper-doc/mydb/42/update", (_url, init) => {
      const req = JSON.parse(init.body as string);
      return json({
        ok: true,
        grant: {
          principal: "actor",
          id: req.actor_id,
          role: req.role,
          actions: ["read"],
          kind: "user",
          display_name: "Bob Editor",
        },
      });
    });
    on("/resource/", () => json(STATE));

    const { events } = mount(BASE_ATTRS);
    const select = page.getByRole("combobox", { name: "Role for Bob Editor" });
    await expect.element(select).toBeInTheDocument();
    await select.selectOptions("Viewer");

    await vi.waitFor(() => {
      const update = calls.find((c) => c.url.includes("/update"));
      expect(update).toBeTruthy();
      expect(update!.method).toBe("POST");
      expect(update!.body).toEqual({ actor_id: "bob", role: "Viewer" });
    });
    await vi.waitFor(() => expect(events["share-updated"]).toHaveLength(1));
    expect(events["share-updated"]![0]!.detail).toMatchObject({
      principal: "actor",
      id: "bob",
      role: "Viewer",
    });
    expect(events["share-changed"]!.length).toBeGreaterThan(0);
  });

  it("reverts the dropdown and shows an error when update fails", async () => {
    on("/resource/paper-doc/mydb/42/update", () =>
      json({ ok: false, error: "nope" }, 403),
    );
    on("/resource/", () => json(STATE));

    const { events } = mount(BASE_ATTRS);
    const select = page.getByRole("combobox", { name: "Role for Bob Editor" });
    await expect.element(select).toBeInTheDocument();
    await select.selectOptions("Viewer");

    await expect.element(page.getByText("nope")).toBeInTheDocument();
    expect(events["share-updated"]).toHaveLength(0);
    // Reverted back to Editor.
    await vi.waitFor(() =>
      expect((select.element() as HTMLSelectElement).value).toBe("Editor"),
    );
  });

  it("remove calls revoke and emits share-revoked", async () => {
    on("/resource/paper-doc/mydb/42/revoke", () => json({ ok: true, removed: 1 }));
    on("/resource/", () => json(STATE));

    const { events } = mount(BASE_ATTRS);
    const removeBtn = page.getByRole("button", { name: "Remove Bob Editor" });
    await expect.element(removeBtn).toBeInTheDocument();
    await removeBtn.click();

    await vi.waitFor(() => {
      const revoke = calls.find((c) => c.url.includes("/revoke"));
      expect(revoke).toBeTruthy();
      expect(revoke!.body).toEqual({ actor_id: "bob" });
    });
    await vi.waitFor(() => expect(events["share-revoked"]).toHaveLength(1));
    expect(events["share-revoked"]![0]!.detail).toMatchObject({
      principal: "actor",
      id: "bob",
    });
    // Row is gone.
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain("Bob Editor"),
    );
  });

  it("read-only mode hides selects and remove buttons", async () => {
    on("/resource/", () => json({ ...STATE, can_manage: false }));
    mount(BASE_ATTRS);

    await expect.element(page.getByText("Bob Editor")).toBeInTheDocument();
    // No editing controls.
    expect(document.querySelectorAll("select").length).toBe(0);
    expect(
      document.querySelectorAll(".datasette-share-dialog__remove").length,
    ).toBe(0);
    // Non-owner role rendered as a read-only tag.
    await expect.element(page.getByText("Editor", { exact: true })).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    on("/resource/", () => json({ error: "Cannot manage" }, 403));
    mount(BASE_ATTRS);
    await expect.element(page.getByText("Cannot manage")).toBeInTheDocument();
  });
});
