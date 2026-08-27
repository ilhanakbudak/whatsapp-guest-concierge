/**
 * Posts a correctly-signed inbound webhook, exactly as Twilio would.
 *
 * Lets the whole pipeline — signature check, allowlist, LLM, calendar tools,
 * reply — be exercised without a phone, and without waiting for the Console
 * webhook to be configured. It signs with the real auth token, so it also
 * verifies that PUBLIC_URL matches what the server expects.
 *
 *   npm run simulate -- "what time is the boat today?"
 *   npm run simulate -- "what's the wifi?" --from +447700900001
 */
import { createHmac } from "node:crypto";
import { loadConfig } from "../src/config/env.js";

const args = process.argv.slice(2);
const flagIndex = args.findIndex((a) => a.startsWith("--"));
const message = (flagIndex === -1 ? args : args.slice(0, flagIndex)).join(" ").trim();

const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!message) {
  console.error('Usage: npm run simulate -- "your message here" [--from +90...]');
  process.exit(1);
}

const config = loadConfig();
const base = value("--url") ?? config.PUBLIC_URL;
const url = `${base}/webhooks/twilio/inbound`;

const params: Record<string, string> = {
  From: `whatsapp:${value("--from") ?? "+447700900001"}`,
  To: config.TWILIO_WHATSAPP_FROM,
  Body: message,
  MessageSid: `SMsim${Date.now()}`,
};

// Twilio's algorithm: the full URL, then each parameter name and value
// concatenated in alphabetical order by name, HMAC-SHA1, base64.
const payload = Object.keys(params)
  .sort()
  .reduce((acc, key) => acc + key + params[key], url);

const signature = createHmac("sha1", config.TWILIO_AUTH_TOKEN ?? "")
  .update(Buffer.from(payload, "utf-8"))
  .digest("base64");

console.log(`POST ${url}`);
console.log(`from ${params.From}`);
console.log(`> ${message}\n`);

const started = Date.now();
const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": signature,
  },
  body: new URLSearchParams(params),
});

const body = await response.text();
const elapsed = Date.now() - started;

console.log(`HTTP ${response.status}  [${elapsed}ms]`);

if (response.status === 403) {
  console.error(
    "\nSignature rejected. PUBLIC_URL must exactly match the URL being called:\n" +
      `  PUBLIC_URL = ${config.PUBLIC_URL}\n` +
      `  called     = ${url}`,
  );
  process.exit(1);
}

const reply = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1];

if (reply) {
  const decoded = reply
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  console.log(`\n< ${decoded}`);
} else {
  console.log(
    `\n(no inline reply — TWILIO_REPLY_MODE is "${config.TWILIO_REPLY_MODE}", ` +
      "so the answer is sent via the Messages API instead)",
  );
}
