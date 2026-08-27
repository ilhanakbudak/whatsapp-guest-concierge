/** Browser chat that drives the real reply pipeline. */

const PHONE_KEY = "concierge.sim.phone";
const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let phone = localStorage.getItem(PHONE_KEY) ?? "";

function bubble(text, side, meta) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${side}`;

  const body = document.createElement("div");
  body.className = "bubble";
  body.textContent = text;
  wrap.append(body);

  if (meta) {
    const label = document.createElement("div");
    label.className = "meta";
    label.textContent = meta;
    wrap.append(label);
  }

  $("log").append(wrap);
  $("log").scrollTo({ top: $("log").scrollHeight, behavior: "smooth" });
}

function typing(on) {
  $("log").querySelector(".typing")?.remove();
  if (!on) return;

  const el = document.createElement("div");
  el.className = "typing";
  el.innerHTML = "<i></i><i></i><i></i>";
  $("log").append(el);
  $("log").scrollTo({ top: $("log").scrollHeight, behavior: "smooth" });
}

async function loadGuests() {
  const guests = await fetch("/simulator/guests").then((r) => r.json());

  if (!Array.isArray(guests) || guests.length === 0) {
    $("who").textContent = "no guests — run npm run seed";
    $("send").disabled = true;
    return;
  }

  phone = guests.some((g) => g.phone === phone) ? phone : guests[0].phone;
  $("guest").innerHTML = guests
    .map((g) => `<option value="${esc(g.phone)}"${g.phone === phone ? " selected" : ""}>${esc(g.name)}</option>`)
    .join("");

  $("who").textContent = "online";
  await loadHistory();
}

async function loadHistory() {
  localStorage.setItem(PHONE_KEY, phone);
  $("log").innerHTML = "";

  const data = await fetch(`/simulator/history?from=${encodeURIComponent(phone)}`).then((r) => r.json());

  if (!data.messages?.length) {
    bubble(
      "Hello! Ask me anything about the villa — the wifi, the schedule, dinner, getting around.",
      "in",
    );
    return;
  }

  for (const m of data.messages) bubble(m.body, m.direction === "inbound" ? "out" : "in");
}

async function send(text) {
  bubble(text, "out");
  $("input").value = "";
  $("send").disabled = true;
  typing(true);

  try {
    const res = await fetch("/simulator/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, from: phone }),
    });
    const data = await res.json();
    typing(false);

    if (!res.ok) {
      bubble(data.message ?? "Something went wrong.", "in");
      return;
    }

    bubble(data.reply, "in", data.elapsedMs ? `${(data.elapsedMs / 1000).toFixed(1)}s` : null);
  } catch (err) {
    typing(false);
    bubble(`Could not reach the server: ${err.message}`, "in");
  } finally {
    $("send").disabled = false;
    $("input").focus();
  }
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("input").value.trim();
  if (text) void send(text);
});

$("chips").addEventListener("click", (event) => {
  const question = event.target.closest("[data-q]")?.dataset.q;
  if (question) void send(question);
});

$("guest").addEventListener("change", (event) => {
  phone = event.target.value;
  void loadHistory();
});

loadGuests().catch((err) => {
  $("who").textContent = "offline";
  bubble(`Could not load guests: ${err.message}`, "in");
});
