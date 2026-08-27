/**
 * Concierge admin console.
 *
 * Plain ES modules against the same HTTP API the docs describe — no framework,
 * no build step. Everything user-supplied is escaped before it reaches innerHTML.
 */

const TOKEN_KEY = "concierge.admin.token";
const SPLIT_KEY = "concierge.admin.split";

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let token = sessionStorage.getItem(TOKEN_KEY) ?? "";

/* ── utilities ──────────────────────────────────────────────────────────── */

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const num = (value) => Number(value ?? 0).toLocaleString();

/**
 * Two timestamp shapes reach this page: JSON-serialised Dates (ISO 8601, with a
 * zone) and SQLite timestamps ("YYYY-MM-DD HH:MM:SS", UTC but unmarked).
 * Appending "Z" to both renders the first invalid.
 */
function ago(value) {
  if (!value) return "never";
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const at = new Date(zoned ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return "unknown";

  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 4600);
}

/** Replaces window.confirm, which cannot be styled and looks unfinished. */
function confirmDialog(title, text, confirmLabel = "Confirm") {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = confirmLabel;

  return new Promise((resolve) => {
    const done = (ok) => {
      dialog.close();
      resolve(ok);
    };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
  });
}

const skeleton = (rows = 3) =>
  `<div style="display:grid;gap:var(--sp-3)">${Array.from(
    { length: rows },
    (_, i) => `<div class="skeleton" style="width:${90 - i * 18}%"></div>`,
  ).join("")}</div>`;

const emptyState = (text) => `<div class="empty">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
  <span>${esc(text)}</span></div>`;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    signOut();
    throw new Error("Session expired — sign in again.");
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? data?.error ?? `Request failed (${res.status})`);
  return data;
}

/* ── auth ───────────────────────────────────────────────────────────────── */

function signOut() {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  $("shell").hidden = true;
  $("gate").hidden = false;
}

$("gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  $("gate-error").hidden = true;

  try {
    await api("/admin/kb");
    sessionStorage.setItem(TOKEN_KEY, token);
    await start();
  } catch (err) {
    $("gate-error").textContent = err.message;
    $("gate-error").hidden = false;
  }
});

$("sign-out").addEventListener("click", signOut);

/* ── navigation ─────────────────────────────────────────────────────────── */

const TITLES = {
  overview: ["Overview", "Usage and health at a glance"],
  announcements: ["Announcements", "Compose, preview, and track delivery"],
  guests: ["Guests", "Only these numbers can use the bot"],
  knowledge: ["House information", "What the assistant answers from"],
};

function navigate(section) {
  $$("[data-section]").forEach((el) => el.classList.toggle("active", el.dataset.section === section));
  $$("[data-nav-to]").forEach((el) =>
    el.setAttribute("aria-current", String(el.dataset.navTo === section)));

  const [title, sub] = TITLES[section] ?? ["", ""];
  $("page-title").textContent = title;
  $("page-sub").textContent = sub;

  $("shell").dataset.nav = "closed";
  $("nav-toggle").setAttribute("aria-expanded", "false");
  location.hash = section;
}

$$("[data-nav-to]").forEach((el) =>
  el.addEventListener("click", () => navigate(el.dataset.navTo)));

$("nav-toggle").addEventListener("click", () => {
  const shell = $("shell");
  const open = shell.dataset.nav !== "open";
  shell.dataset.nav = open ? "open" : "closed";
  $("nav-toggle").setAttribute("aria-expanded", String(open));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("shell").dataset.nav = "closed";
});

/* ── resizable split ────────────────────────────────────────────────────── */

(function initResize() {
  const split = $("announce-split");
  const handle = $("resize-handle");
  if (!split || !handle) return;

  const apply = (percent) => {
    const clamped = Math.min(78, Math.max(30, percent));
    split.style.setProperty("--split", `${clamped}%`);
    localStorage.setItem(SPLIT_KEY, String(clamped));
  };

  apply(Number(localStorage.getItem(SPLIT_KEY) ?? 62));

  handle.addEventListener("pointerdown", (event) => {
    handle.setPointerCapture(event.pointerId);
    const rect = split.getBoundingClientRect();

    const move = (e) => apply(((e.clientX - rect.left) / rect.width) * 100);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  // Keyboard-operable, because a drag handle that only responds to a mouse is
  // not actually a control.
  handle.addEventListener("keydown", (event) => {
    const current = Number(localStorage.getItem(SPLIT_KEY) ?? 62);
    if (event.key === "ArrowLeft") apply(current - 3);
    else if (event.key === "ArrowRight") apply(current + 3);
    else return;
    event.preventDefault();
  });
})();

/* ── rendering ──────────────────────────────────────────────────────────── */

async function loadOverview() {
  $("stats").innerHTML = skeleton(1);

  const [ready, usage, guests] = await Promise.all([
    fetch("/health/ready").then((r) => r.json()),
    api("/admin/usage?days=7"),
    api("/admin/guests"),
  ]);

  const cache = Math.round((usage.cacheHitRate ?? 0) * 100);
  $("stats").innerHTML = [
    [guests.length, "active guests"],
    [num(usage.events), "replies"],
    [`${cache}%`, "input cached"],
    [num(usage.inputTokens + usage.cachedInputTokens), "input tokens"],
    [num(usage.outputTokens), "output tokens"],
  ]
    .map(([n, k]) => `<div class="stat"><span class="n">${esc(n)}</span><span class="k">${esc(k)}</span></div>`)
    .join("");

  $("assistant-body").innerHTML = `
    <div class="stats">
      <div class="stat"><span class="n sm">${esc(ready.llm.provider)}</span><span class="k">provider</span></div>
      <div class="stat"><span class="n sm mono">${esc(ready.llm.model)}</span><span class="k">model</span></div>
    </div>
    <div class="notice ${cache > 20 ? "ok" : ""}" style="margin-top:var(--sp-4)">
      <strong>${cache}% of input tokens served from cache</strong>
      <span class="small muted">The house information sits behind a cache breakpoint, so it is not re-billed on every message.</span>
    </div>`;

  const pill = $("env-pill");
  pill.hidden = false;
  pill.className = ready.demoMode ? "pill warn" : "pill ok";
  pill.textContent = ready.demoMode ? "Demo mode" : "Live";
  $("nav-env").textContent = ready.demoMode ? "Demo mode" : "Concierge admin";
}

async function loadActivity() {
  $("activity").innerHTML = `<div class="panel-body">${skeleton(4)}</div>`;
  const messages = await api("/admin/activity?limit=14");

  if (messages.length === 0) {
    $("activity").innerHTML = emptyState("No messages yet.");
    return;
  }

  $("activity").innerHTML = `<div style="display:grid;gap:var(--sp-3);padding:var(--sp-4) var(--sp-5)">
    ${messages
      .slice()
      .reverse()
      .map((m) => {
        const outbound = m.direction === "outbound";
        return `<div style="display:grid;gap:2px;justify-items:${outbound ? "end" : "start"}">
          <div class="hint">${outbound ? "Concierge" : esc(m.guest)} · ${esc(ago(m.at))}</div>
          <div class="bubble-preview" style="${
            outbound
              ? "background:var(--accent-bg);border-color:transparent"
              : ""
          };max-width:min(88%,460px)">${esc(m.body.length > 190 ? `${m.body.slice(0, 190)}…` : m.body)}</div>
        </div>`;
      })
      .join("")}</div>`;
}

async function loadGuests() {
  $("guests").innerHTML = `<div class="panel-body">${skeleton(3)}</div>`;
  const guests = await api("/admin/guests");

  $("guest-count").textContent = `${guests.length} active`;
  $("nav-guest-count").textContent = guests.length;

  if (guests.length === 0) {
    $("guests").innerHTML = emptyState("No guests yet — add one above.");
    return;
  }

  $("guests").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Number</th><th class="right">Action</th></tr></thead>
    <tbody>${guests
      .map(
        (g) => `<tr>
          <td data-label="Name">${esc(g.name)}${g.role === "admin" ? ' <span class="pill">admin</span>' : ""}</td>
          <td data-label="Number" class="mono muted">${esc(g.phone)}</td>
          <td data-label="" class="right"><button class="btn sm danger" data-remove="${esc(g.phone)}" data-name="${esc(g.name)}">Remove</button></td>
        </tr>`,
      )
      .join("")}</tbody></table></div>`;
}

function kbSummary(kb) {
  return `
    <div class="stats">
      <div class="stat"><span class="n">${num(kb.characters)}</span><span class="k">characters</span></div>
      <div class="stat"><span class="n sm">${esc(ago(kb.fetchedAt))}</span><span class="k">last loaded</span></div>
      <div class="stat"><span class="n sm">${kb.history?.length ? esc(ago(kb.history[0].fetchedAt)) : "—"}</span><span class="k">last changed</span></div>
    </div>
    <div class="small muted mono" style="margin-top:var(--sp-4)">${esc(kb.source)}</div>
    ${kb.lastError ? `<div class="notice danger" style="margin-top:var(--sp-3)">${esc(kb.lastError)}</div>` : ""}`;
}

async function loadKb() {
  $("kb-body").innerHTML = skeleton(2);
  $("kb-mini").innerHTML = skeleton(2);

  const kb = await api("/admin/kb");
  $("kb-body").innerHTML = kbSummary(kb);
  $("kb-mini").innerHTML = kbSummary(kb);

  $("kb-history").innerHTML = kb.history?.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Version</th><th>Size</th><th>When</th></tr></thead>
        <tbody>${kb.history
          .map(
            (h) => `<tr>
              <td data-label="Version" class="mono muted">${esc(h.hash)}</td>
              <td data-label="Size">${num(h.characters)} chars</td>
              <td data-label="When" class="muted nowrap">${esc(ago(h.fetchedAt))}</td>
            </tr>`,
          )
          .join("")}</tbody></table></div>`
    : emptyState("No changes recorded yet.");
}

async function loadBroadcasts() {
  $("broadcasts").innerHTML = `<div class="panel-body">${skeleton(2)}</div>`;
  const list = await api("/admin/broadcasts");

  if (list.length === 0) {
    $("broadcasts").innerHTML = emptyState("Nothing sent yet.");
    return;
  }

  $("broadcasts").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Message</th><th>Delivery</th><th>When</th></tr></thead>
    <tbody>${list
      .map((b) => {
        const c = b.counts ?? {};
        // "sent" means Twilio accepted it; "delivered" means the phone received
        // it. Conflating them would overstate what we actually know.
        const confirmed = (c.delivered ?? 0) + (c.read ?? 0);
        const failed = (c.failed ?? 0) + (c.undelivered ?? 0);
        const pending = (c.queued ?? 0) + (c.sending ?? 0);
        const label = confirmed > 0 ? `${confirmed} delivered` : `${c.sent ?? 0} sent`;

        return `<tr>
          <td data-label="Message">${esc(b.body.length > 70 ? `${b.body.slice(0, 70)}…` : b.body)}</td>
          <td data-label="Delivery" style="display:flex;gap:var(--sp-2);flex-wrap:wrap">
            <span class="pill ${failed ? "warn" : "ok"}">${label}</span>
            ${failed ? `<span class="pill danger">${failed} failed</span>` : ""}
            ${pending ? `<span class="pill">${pending} pending</span>` : ""}
          </td>
          <td data-label="When" class="muted small nowrap">${esc(ago(b.createdAt))}</td>
        </tr>`;
      })
      .join("")}</tbody></table></div>`;
}

/* ── actions ────────────────────────────────────────────────────────────── */

$("message").addEventListener("input", (event) => {
  $("char-count").textContent = `${event.target.value.length} / 1500`;
  // Any edit invalidates the preview, so sending is disabled until it is redone.
  $("send-btn").disabled = true;
  $("preview-area").innerHTML = "";
});

$("broadcast-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("message").value.trim();
  if (!message) return;

  $("preview-btn").disabled = true;
  try {
    const preview = await api("/admin/broadcast", {
      method: "POST",
      body: JSON.stringify({ message, dryRun: true }),
    });

    $("preview-area").innerHTML = `
      <div class="notice ${preview.warnings.length ? "warn" : "ok"}">
        <strong>Will send to ${preview.recipientCount} guest${preview.recipientCount === 1 ? "" : "s"}</strong>
        ${preview.warnings.map((w) => `<span class="small">${esc(w)}</span>`).join("")}
      </div>
      ${preview.samples
        .map(
          (s) => `<div>
            <div class="hint" style="margin-bottom:var(--sp-1)">${esc(s.name)} · <span class="mono">${esc(s.phone)}</span></div>
            <div class="bubble-preview">${esc(s.body)}</div>
          </div>`,
        )
        .join("")}`;

    $("send-btn").disabled = preview.recipientCount === 0;
  } catch (err) {
    toast(err.message, "danger");
  } finally {
    $("preview-btn").disabled = false;
  }
});

$("send-btn").addEventListener("click", async () => {
  const message = $("message").value.trim();
  const count = $("preview-area").querySelector("strong")?.textContent ?? "every guest";

  const ok = await confirmDialog(
    "Send this announcement?",
    `${count}. A broadcast reaches everyone at once and cannot be recalled.`,
    "Send now",
  );
  if (!ok) return;

  $("send-btn").disabled = true;
  try {
    const res = await api("/admin/broadcast", { method: "POST", body: JSON.stringify({ message }) });
    toast(`Queued for ${res.queued} guest${res.queued === 1 ? "" : "s"}.`);
    $("message").value = "";
    $("char-count").textContent = "0 / 1500";
    $("preview-area").innerHTML = "";
    setTimeout(loadBroadcasts, 1200);
  } catch (err) {
    toast(err.message, "danger");
    $("send-btn").disabled = false;
  }
});

$("guest-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/admin/guests", {
      method: "POST",
      body: JSON.stringify({ phone: $("guest-phone").value, name: $("guest-name").value }),
    });
    toast("Guest added.");
    $("guest-phone").value = "";
    $("guest-name").value = "";
    await Promise.all([loadGuests(), loadOverview()]);
  } catch (err) {
    toast(err.message, "danger");
  }
});

$("guests").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;

  const ok = await confirmDialog(
    `Remove ${button.dataset.name}?`,
    "They will no longer be able to message the bot. Their history is kept.",
    "Remove",
  );
  if (!ok) return;

  try {
    await api(`/admin/guests/${encodeURIComponent(button.dataset.remove)}`, { method: "DELETE" });
    toast("Guest removed.");
    await Promise.all([loadGuests(), loadOverview()]);
  } catch (err) {
    toast(err.message, "danger");
  }
});

$$("[data-refresh-kb]").forEach((button) =>
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await api("/admin/kb/refresh", { method: "POST" });
      toast(result.changed ? "House information updated." : "Already up to date.");
      await loadKb();
    } catch (err) {
      toast(err.message, "danger");
    } finally {
      button.disabled = false;
    }
  }));

$("reload").addEventListener("click", () => void refreshAll());

/* ── boot ───────────────────────────────────────────────────────────────── */

async function refreshAll() {
  try {
    await Promise.all([loadOverview(), loadActivity(), loadGuests(), loadKb(), loadBroadcasts()]);
  } catch (err) {
    toast(err.message, "danger");
  }
}

async function start() {
  $("gate").hidden = true;
  $("shell").hidden = false;
  navigate(location.hash.slice(1) in TITLES ? location.hash.slice(1) : "overview");
  await refreshAll();
}

if (token) start().catch(signOut);
