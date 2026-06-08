import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
// Importing the component registers the <datasette-acl-share-dialog> custom element.
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
  document.querySelectorAll("datasette-acl-share-dialog").forEach((n) => n.remove());
});

function mount(
  attrs: Record<string, string>,
): { el: HTMLElement; events: Record<string, CustomEvent[]> } {
  const el = document.createElement("datasette-acl-share-dialog");
  // Open the modal on mount so tests interact with the dialog content directly
  // (the component otherwise waits for a trigger click). Individual tests can
  // override by passing their own `open`.
  for (const [k, v] of Object.entries({ open: "true", ...attrs })) {
    el.setAttribute(k, v);
  }
  const events: Record<string, CustomEvent[]> = {};
  for (const type of [
    "share-granted",
    "share-updated",
    "share-revoked",
    "share-changed",
  ]) {
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

describe("<datasette-acl-share-dialog> trigger + modal", () => {
  it("stays closed (no load) until the trigger is clicked, then opens", async () => {
    on("/resource/", () => json(STATE));

    // Mount WITHOUT auto-open by creating the element directly.
    const el = document.createElement("datasette-acl-share-dialog");
    for (const [k, v] of Object.entries(BASE_ATTRS)) el.setAttribute(k, v);
    document.body.appendChild(el);

    // The trigger is present; the resource has not been fetched and the dialog
    // content (the grant rows) is not shown.
    const trigger = page.getByRole("button", { name: 'Share “Q2 Planning”' });
    await expect.element(trigger).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/resource/"))).toBe(false);
    expect(page.getByText("Bob Editor").query()).toBeNull();

    // Clicking the trigger loads + reveals the dialog.
    await trigger.click();
    await expect.element(page.getByText("Bob Editor")).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/resource/"))).toBe(true);
  });

  it("disabled trigger can't open the dialog", async () => {
    on("/resource/", () => json(STATE));

    const el = document.createElement("datasette-acl-share-dialog");
    for (const [k, v] of Object.entries(BASE_ATTRS)) el.setAttribute(k, v);
    el.setAttribute("disabled", "");
    document.body.appendChild(el);

    const trigger = page.getByRole("button", { name: 'Share “Q2 Planning”' });
    await expect.element(trigger).toBeInTheDocument();
    await expect.element(trigger).toBeDisabled();

    // Even an explicit open attribute must not open a disabled dialog.
    el.setAttribute("open", "true");
    await new Promise((r) => setTimeout(r, 0));
    expect((document.querySelector("dialog") as HTMLDialogElement).open).toBe(
      false,
    );
    expect(calls.some((c) => c.url.includes("/resource/"))).toBe(false);
  });

  it("closes when the Close button is clicked", async () => {
    on("/resource/", () => json(STATE));
    mount(BASE_ATTRS); // auto-opens

    await expect.element(page.getByText("Bob Editor")).toBeInTheDocument();
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);

    await page.getByRole("button", { name: "Close" }).click();
    expect(dialog.open).toBe(false);
  });
});

describe("<datasette-acl-share-dialog> people-with-access list", () => {
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
      document.querySelectorAll(".datasette-acl-share-dialog__remove").length,
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

// --- add-box pickers -------------------------------------------------------

describe("<datasette-acl-share-dialog> add-box pickers", () => {
  it("typing in People calls searchPeople (debounced) and renders results", async () => {
    on("/profiles/api/search", () => {
      // carol matches the query
      return json({
        results: [
          {
            id: "carol",
            display_name: "Carol Smith",
            email: "carol@x.com",
            kind: "user",
          },
        ],
      });
    });
    on("/resource/", () => json(STATE));

    mount(BASE_ATTRS);
    const input = page.getByRole("combobox", { name: "Search people" });
    await expect.element(input).toBeInTheDocument();
    await input.fill("car");

    await vi.waitFor(() => {
      const search = calls.find((c) => c.url.includes("/profiles/api/search"));
      expect(search).toBeTruthy();
      expect(search!.url).toContain("q=car");
    });
    // Results render in the floating overlay listbox.
    await expect.element(page.getByText("Carol Smith")).toBeInTheDocument();
    expect(
      document.querySelectorAll("#datasette-acl-share-results [role='option']")
        .length,
    ).toBe(1);
  });

  it("selecting people + Share grants the batch and emits share-granted per pill", async () => {
    on("/profiles/api/search", () =>
      json({
        results: [
          { id: "carol", display_name: "Carol Smith", kind: "user" },
          { id: "dave", display_name: "Dave Jones", kind: "user" },
        ],
      }),
    );
    on("/resource/paper-doc/mydb/42/grant", (_url, init) => {
      const req = JSON.parse(init.body as string);
      return json({
        ok: true,
        grant: {
          principal: "actor",
          id: req.actor_id,
          role: req.role,
          actions: ["read", "write"],
          kind: "user",
          display_name: req.actor_id === "carol" ? "Carol Smith" : "Dave Jones",
        },
      });
    });
    on("/resource/", () => json(STATE));

    const { events } = mount(BASE_ATTRS);
    const input = page.getByRole("combobox", { name: "Search people" });
    await expect.element(input).toBeInTheDocument();

    // Pick Carol — she becomes a removable pill, not an immediate grant.
    await input.fill("ca");
    await page.getByRole("option", { name: /Carol Smith/ }).click();
    // Clicking adds the pill and clears the box; no grant call yet.
    expect(calls.find((c) => c.url.endsWith("/grant"))).toBeFalsy();
    await expect
      .element(page.getByRole("button", { name: "Remove Carol Smith" }))
      .toBeInTheDocument();

    // Pick Dave too.
    await input.fill("da");
    await page.getByRole("option", { name: /Dave Jones/ }).click();
    await expect
      .element(page.getByRole("button", { name: "Remove Dave Jones" }))
      .toBeInTheDocument();

    // Share grants BOTH pills at the chosen role.
    const shareBtn = page.getByRole("button", { name: "Share", exact: true });
    await shareBtn.click();

    await vi.waitFor(() => {
      const grants = calls.filter((c) => c.url.endsWith("/grant"));
      expect(grants).toHaveLength(2);
      expect(grants.map((g) => (g.body as { actor_id: string }).actor_id)).toEqual([
        "carol",
        "dave",
      ]);
      grants.forEach((g) =>
        expect(g.body).toMatchObject({ role: "Editor" }),
      );
    });
    await vi.waitFor(() => expect(events["share-granted"]).toHaveLength(2));
    expect(events["share-granted"]!.map((e) => e.detail.id)).toEqual([
      "carol",
      "dave",
    ]);
    // Pills cleared after a successful batch.
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll(".datasette-acl-share-dialog__pill").length,
      ).toBe(0),
    );
  });

  it("Share is disabled until at least one pill is selected", async () => {
    on("/profiles/api/search", () =>
      json({ results: [{ id: "carol", display_name: "Carol Smith", kind: "user" }] }),
    );
    on("/resource/", () => json(STATE));

    mount(BASE_ATTRS);
    const shareBtn = page.getByRole("button", { name: "Share", exact: true });
    await expect.element(shareBtn).toBeDisabled();

    const input = page.getByRole("combobox", { name: "Search people" });
    await input.fill("ca");
    await page.getByRole("option", { name: /Carol Smith/ }).click();
    await expect.element(shareBtn).toBeEnabled();
  });

  it("a selected pill can be removed before sharing", async () => {
    on("/profiles/api/search", () =>
      json({ results: [{ id: "carol", display_name: "Carol Smith", kind: "user" }] }),
    );
    on("/resource/", () => json(STATE));

    mount(BASE_ATTRS);
    const input = page.getByRole("combobox", { name: "Search people" });
    await input.fill("ca");
    await page.getByRole("option", { name: /Carol Smith/ }).click();
    const removeBtn = page.getByRole("button", { name: "Remove Carol Smith" });
    await expect.element(removeBtn).toBeInTheDocument();
    await removeBtn.click();
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll(".datasette-acl-share-dialog__pill").length,
      ).toBe(0),
    );
    await expect
      .element(page.getByRole("button", { name: "Share", exact: true }))
      .toBeDisabled();
  });

  it("keyboard: ArrowDown highlights and Enter adds the result as a pill", async () => {
    on("/profiles/api/search", () =>
      json({
        results: [
          { id: "carol", display_name: "Carol Smith", kind: "user" },
          { id: "dave", display_name: "Dave Jones", kind: "user" },
        ],
      }),
    );
    on("/resource/", () => json(STATE));

    mount(BASE_ATTRS);
    const input = page.getByRole("combobox", { name: "Search people" });
    await input.fill("a");
    await expect.element(page.getByText("Carol Smith")).toBeInTheDocument();

    const el = input.element() as HTMLInputElement;
    el.focus();
    // ArrowDown twice → highlight the second option (Dave), Enter picks it.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    await expect
      .element(page.getByRole("button", { name: "Remove Dave Jones" }))
      .toBeInTheDocument();
    // No grant call — Enter only queues the pill.
    expect(calls.find((c) => c.url.endsWith("/grant"))).toBeFalsy();
  });

  it("keyboard: Escape dismisses the results overlay", async () => {
    on("/profiles/api/search", () =>
      json({ results: [{ id: "carol", display_name: "Carol Smith", kind: "user" }] }),
    );
    on("/resource/", () => json(STATE));

    mount(BASE_ATTRS);
    const input = page.getByRole("combobox", { name: "Search people" });
    await input.fill("ca");
    await expect.element(page.getByText("Carol Smith")).toBeInTheDocument();

    const el = input.element() as HTMLInputElement;
    el.focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(document.querySelector("#datasette-acl-share-results")).toBeNull(),
    );
  });

  it("adding a person who already has a grant focuses the existing row", async () => {
    // Search returns bob, who is already granted in STATE.
    on("/profiles/api/search", () =>
      json({ results: [{ id: "bob", display_name: "Bob Editor", kind: "user" }] }),
    );
    on("/resource/", () => json(STATE));

    mount(BASE_ATTRS);
    const input = page.getByRole("combobox", { name: "Search people" });
    await expect.element(input).toBeInTheDocument();
    await input.fill("bob");
    // The result for bob should be filtered out (already granted): no option,
    // and so no pill can be created for him.
    await vi.waitFor(() => {
      const opts = document.querySelectorAll(
        "#datasette-acl-share-results [role='option']",
      );
      expect(opts.length).toBe(0);
    });
    expect(document.querySelectorAll(".datasette-acl-share-dialog__pill").length).toBe(
      0,
    );
    // No grant call was issued.
    expect(calls.find((c) => c.url.endsWith("/grant"))).toBeFalsy();
  });

  it("hides the Groups tab when the groups capability is absent", async () => {
    on("/resource/", () => json(STATE));
    mount({ ...BASE_ATTRS, features: "people,public" });
    // Wait for load, then assert the groups tab isn't present (only People
    // remains, so the tablist collapses to a single picker).
    await expect.element(page.getByText("Bob Editor")).toBeInTheDocument();
    expect(
      document.querySelector("[role='tab'][id='datasette-acl-share-tab-groups']"),
    ).toBeNull();
  });

  it("shows People and Groups tabs when both capabilities are present", async () => {
    on("/resource/", () => json(STATE));
    mount({ ...BASE_ATTRS, features: "people,groups,public" });
    await expect
      .element(page.getByRole("tab", { name: "People" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("tab", { name: "Groups" }))
      .toBeInTheDocument();
  });
});

// --- general access --------------------------------------------------------

describe("<datasette-acl-share-dialog> general access", () => {
  it("choosing 'Anyone signed in' then a role issues a _signed_in grant", async () => {
    on("/resource/paper-doc/mydb/42/grant", (_url, init) => {
      const req = JSON.parse(init.body as string);
      return json({
        ok: true,
        grant: {
          principal: "actor",
          id: req.actor_id,
          role: req.role,
          actions: ["read", "write"],
          kind: "public",
        },
      });
    });
    on("/resource/", () => json(STATE));

    const { events } = mount(BASE_ATTRS);
    const principal = page.getByRole("combobox", { name: "General access", exact: true });
    await expect.element(principal).toBeInTheDocument();
    await principal.selectOptions("Anyone signed in");

    await vi.waitFor(() => {
      const g = calls.find((c) => c.url.endsWith("/grant"));
      expect(g).toBeTruthy();
      expect(g!.body).toMatchObject({ actor_id: "_signed_in", role: "Editor" });
    });
    await vi.waitFor(() => expect(events["share-granted"]).toHaveLength(1));
  });

  it("offers BOTH 'Anyone' (*) and 'Anyone signed in' (_signed_in) options", async () => {
    on("/resource/", () => json(STATE));
    mount(BASE_ATTRS);
    const principal = page.getByRole("combobox", { name: "General access", exact: true });
    await expect.element(principal).toBeInTheDocument();
    const sel = principal.element() as HTMLSelectElement;
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toContain("*");
    expect(values).toContain("_signed_in");
    expect(values).toContain(""); // Restricted
  });

  it("an existing wildcard grant pre-selects the control", async () => {
    on("/resource/", () =>
      json({
        ...STATE,
        grants: [
          ...STATE.grants,
          {
            principal: "actor",
            id: "*",
            role: "Viewer",
            actions: ["read"],
            kind: "public",
          },
        ],
      }),
    );
    mount(BASE_ATTRS);
    const principal = page.getByRole("combobox", { name: "General access", exact: true });
    await expect.element(principal).toBeInTheDocument();
    await vi.waitFor(() =>
      expect((principal.element() as HTMLSelectElement).value).toBe("*"),
    );
    const role = page.getByRole("combobox", { name: "General access role" });
    await vi.waitFor(() =>
      expect((role.element() as HTMLSelectElement).value).toBe("Viewer"),
    );
    // Wildcard grant is NOT rendered in the people-with-access list.
    expect(document.querySelectorAll("[data-principal-key='actor:*']").length).toBe(0);
  });

  it("switching to Restricted revokes the wildcard grant", async () => {
    on("/resource/paper-doc/mydb/42/revoke", () => json({ ok: true, removed: 1 }));
    on("/resource/", () =>
      json({
        ...STATE,
        grants: [
          ...STATE.grants,
          {
            principal: "actor",
            id: "_signed_in",
            role: "Viewer",
            actions: ["read"],
            kind: "public",
          },
        ],
      }),
    );
    const { events } = mount(BASE_ATTRS);
    const principal = page.getByRole("combobox", { name: "General access", exact: true });
    await expect.element(principal).toBeInTheDocument();
    await vi.waitFor(() =>
      expect((principal.element() as HTMLSelectElement).value).toBe("_signed_in"),
    );
    await principal.selectOptions("Restricted");

    await vi.waitFor(() => {
      const r = calls.find((c) => c.url.endsWith("/revoke"));
      expect(r).toBeTruthy();
      expect(r!.body).toMatchObject({ actor_id: "_signed_in" });
    });
    await vi.waitFor(() =>
      expect(events["share-revoked"]!.length).toBeGreaterThan(0),
    );
  });
});
