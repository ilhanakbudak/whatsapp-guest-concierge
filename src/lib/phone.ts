import { ValidationError } from "./errors.js";

const WHATSAPP_PREFIX = "whatsapp:";

/** E.164: '+', a 1-9 country-code lead, then up to 14 more digits. */
const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * A phone number in E.164, guaranteed valid by construction.
 * Storage always uses this form; the `whatsapp:` prefix is a Twilio transport
 * detail added at the edge, never persisted.
 */
export type E164Number = string & { readonly __brand: "E164" };

/**
 * Accepts the shapes that actually turn up: Twilio's `whatsapp:+1...`, numbers
 * with spaces/parens/dashes, and `00`-prefixed international dialling.
 */
export function normalizePhone(input: string): E164Number {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ValidationError("Phone number is empty");
  }

  let value = input.trim();

  if (value.toLowerCase().startsWith(WHATSAPP_PREFIX)) {
    value = value.slice(WHATSAPP_PREFIX.length).trim();
  }

  // Strip formatting humans add: spaces, dots, dashes, parens.
  value = value.replace(/[\s.\-()]/g, "");

  // 00 is the international dialling prefix in much of the world; + is its E.164
  // equivalent. Do this before the +-check so '0044...' resolves.
  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }

  if (!value.startsWith("+")) {
    throw new ValidationError(
      `Phone number "${input}" is missing a country code. Use E.164, e.g. +447700900123.`,
    );
  }

  if (!E164.test(value)) {
    throw new ValidationError(`Phone number "${input}" is not valid E.164`);
  }

  return value as E164Number;
}

/** Non-throwing variant, for parsing untrusted input. */
export function tryNormalizePhone(input: string): E164Number | null {
  try {
    return normalizePhone(input);
  } catch {
    return null;
  }
}

/** Add the transport prefix Twilio requires on the wire. */
export function toWhatsAppAddress(phone: E164Number): string {
  return `${WHATSAPP_PREFIX}${phone}`;
}

/** Strip Twilio's transport prefix and validate in one step. */
export function fromWhatsAppAddress(address: string): E164Number {
  return normalizePhone(address);
}

/** For logs and the dashboard: +447700900123 -> +4477****0123 */
export function maskPhone(phone: string): string {
  if (phone.length <= 8) return "****";
  return `${phone.slice(0, 5)}****${phone.slice(-4)}`;
}
