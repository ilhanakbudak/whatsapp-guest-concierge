/**
 * Captures the README screenshots from a running instance.
 *
 * Drives a locally installed Chrome over the DevTools Protocol rather than
 * pulling in Playwright: the only thing needed beyond a screenshot is seeding
 * sessionStorage with the admin token, and that is one Runtime.evaluate call.
 *
 *   npm run dev                     (in another terminal, with seeded data)
 *   npm run screenshots
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3000";
const TOKEN = process.env.ADMIN_API_TOKEN ?? "change-me";
const OUT = process.env.SHOT_OUT ?? "docs/assets";
const PORT = 9333;

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const SHOTS = [
  { name: "dashboard", path: "/dashboard", width: 1280, height: 1120 },
  {
    name: "simulator",
    path: "/simulator",
    width: 760,
    height: 720,
    // Pick the guest who actually has a conversation, so the capture shows the
    // bot working rather than an empty thread.
    seed: `localStorage.setItem("concierge.sim.phone", "+447700900001")`,
  },
];

await mkdir(OUT, { recursive: true });

const profile = `/tmp/concierge-shots-${process.pid}`;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--force-device-scale-factor=2",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const cleanup = async () => {
  chrome.kill();
  // Chrome releases its profile files asynchronously; a failed cleanup must not
  // fail the run, the screenshots are already written.
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
};

/** Chrome needs a moment before the debugging port answers. */
async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools port never opened");
}

class Session {
  #ws;
  #id = 0;
  #pending = new Map();

  static async open(wsUrl) {
    const session = new Session();
    session.#ws = new WebSocket(wsUrl);
    session.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const resolver = session.#pending.get(msg.id);
      if (!resolver) return;
      session.#pending.delete(msg.id);
      if (msg.error) resolver.reject(new Error(msg.error.message));
      else resolver.resolve(msg.result);
    });
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener("open", resolve, { once: true });
      session.#ws.addEventListener("error", reject, { once: true });
    });
    return session;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

try {
  await waitForDevtools();

  for (const shot of SHOTS) {
    const target = await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + shot.path)}`,
      { method: "PUT" },
    ).then((r) => r.json());

    const session = await Session.open(target.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // The dashboard reads its token from sessionStorage, so seed it and reload.
    await session.send("Runtime.evaluate", {
      expression: `sessionStorage.setItem("concierge.admin.token", ${JSON.stringify(TOKEN)})`,
    });
    if (shot.seed) await session.send("Runtime.evaluate", { expression: shot.seed });
    await session.send("Page.reload", { ignoreCache: true });

    // Give the page's fetches time to land before capturing.
    await sleep(3500);

    const { data } = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });

    await writeFile(`${OUT}/${shot.name}.png`, Buffer.from(data, "base64"));
    console.log(`  ${OUT}/${shot.name}.png`);

    session.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  }
} finally {
  await cleanup();
}
