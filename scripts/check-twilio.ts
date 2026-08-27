/**
 * Diagnoses Twilio WhatsApp configuration.
 *
 * Reports which sender is configured, who has joined the sandbox (derived from
 * inbound message history, since the sandbox participant list is not exposed by
 * the API), and whether each guest on the allowlist is inside the 24-hour
 * messaging window that free-form sends require.
 *
 *   npm run check:twilio
 */
import twilio from "twilio";
import { loadConfig } from "../src/config/env.js";
import { openDatabase } from "../src/db/index.js";
import { createRepositories } from "../src/db/repositories/index.js";
import { maskPhone, normalizePhone, tryNormalizePhone } from "../src/lib/phone.js";

const config = loadConfig();

if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
  console.error("Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env first.");
  process.exit(1);
}

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

const account = await client.api.v2010.accounts(config.TWILIO_ACCOUNT_SID).fetch();
console.log("account");
console.log(`  name    ${account.friendlyName}`);
console.log(`  status  ${account.status}`);
console.log(`  type    ${account.type}`);
console.log(`\nsender    ${config.TWILIO_WHATSAPP_FROM}`);
console.log(`public    ${config.PUBLIC_URL}`);

// --- Who has messaged the sandbox? ------------------------------------------

const messages = await client.messages.list({ limit: 200 });
const whatsappMessages = messages.filter(
  (m) => m.from?.startsWith("whatsapp:") || m.to?.startsWith("whatsapp:"),
);

const inbound = whatsappMessages.filter((m) => m.direction === "inbound");

/** Last inbound message per number — this is what opens the 24-hour window. */
const lastInbound = new Map<string, Date>();
for (const message of inbound) {
  const phone = tryNormalizePhone(message.from ?? "");
  if (!phone) continue;

  const at = message.dateSent ?? message.dateCreated;
  if (!at) continue;
  if (!lastInbound.has(phone) || lastInbound.get(phone)! < at) lastInbound.set(phone, at);
}

console.log(`\nwhatsapp messages   ${whatsappMessages.length} in recent history`);
console.log(`inbound senders     ${lastInbound.size}`);

const WINDOW_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

if (lastInbound.size === 0) {
  console.log(
    "\n  Nobody has messaged the sandbox yet. Each phone must send the\n" +
      "  `join <two-words>` code to the sandbox number before it can receive\n" +
      "  anything — that also opens the 24-hour window broadcasts need.",
  );
} else {
  console.log();
  for (const [phone, at] of [...lastInbound].sort((a, b) => +b[1] - +a[1])) {
    const age = now - at.getTime();
    const open = age < WINDOW_MS;
    const hours = Math.floor(age / 3_600_000);

    console.log(
      `  ${phone}  last inbound ${hours}h ago  ` +
        `${open ? `window OPEN (${Math.floor((WINDOW_MS - age) / 3_600_000)}h left)` : "window CLOSED"}`,
    );
  }
}

// --- Cross-check against the guest allowlist --------------------------------

const db = openDatabase({ path: config.DATABASE_PATH });
const repos = createRepositories(db);
const guests = repos.guests.list({ activeOnly: true });

console.log(`\nallowlist  ${guests.length} active guest(s)`);

for (const guest of guests) {
  const at = lastInbound.get(guest.phone);
  const state = !at
    ? "has NOT joined the sandbox — cannot receive messages"
    : now - at.getTime() < WINDOW_MS
      ? "ready"
      : "joined, but the 24h window has closed — ask them to message the bot";

  console.log(`  ${maskPhone(guest.phone)}  ${guest.name.padEnd(16)} ${state}`);
}

const notOnList = [...lastInbound.keys()].filter(
  (phone) => !guests.some((g) => g.phone === phone),
);

if (notOnList.length > 0) {
  console.log(`\nmessaged the bot but NOT on the allowlist`);
  for (const phone of notOnList) {
    console.log(`  ${phone}`);
    console.log(
      `    add with: sqlite3 ${config.DATABASE_PATH} ` +
        `"INSERT INTO guests (phone, name) VALUES ('${normalizePhone(phone)}', 'Name');"`,
    );
  }
}

db.close();
