import { describe, expect, it } from "vitest";
import {
  fromWhatsAppAddress,
  maskPhone,
  normalizePhone,
  toWhatsAppAddress,
  tryNormalizePhone,
} from "../src/lib/phone.js";

describe("normalizePhone", () => {
  it("passes through a clean E.164 number", () => {
    expect(normalizePhone("+447700900123")).toBe("+447700900123");
  });

  it("strips Twilio's whatsapp: transport prefix", () => {
    expect(normalizePhone("whatsapp:+14155238886")).toBe("+14155238886");
  });

  it("is case-insensitive about the prefix", () => {
    expect(normalizePhone("WhatsApp:+14155238886")).toBe("+14155238886");
  });

  it("strips human formatting", () => {
    expect(normalizePhone("+1 (415) 523-8886")).toBe("+14155238886");
    expect(normalizePhone("+44 7700 900.123")).toBe("+447700900123");
  });

  it("converts a 00 international prefix to +", () => {
    expect(normalizePhone("00447700900123")).toBe("+447700900123");
  });

  it("handles a prefixed and formatted number together", () => {
    expect(normalizePhone("whatsapp:+1 (415) 523-8886")).toBe("+14155238886");
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["4155238886", "no country code"],
    ["+0155238886", "country code starting with 0"],
    ["+", "just a plus"],
    ["+1234567890123456", "too long for E.164"],
    ["+1-800-FLOWERS", "letters"],
  ])("rejects %j (%s)", (input) => {
    expect(() => normalizePhone(input)).toThrow();
  });
});

describe("tryNormalizePhone", () => {
  it("returns null instead of throwing", () => {
    expect(tryNormalizePhone("nonsense")).toBeNull();
    expect(tryNormalizePhone("+447700900123")).toBe("+447700900123");
  });
});

describe("whatsapp addressing", () => {
  it("round-trips through the transport prefix", () => {
    const phone = normalizePhone("+447700900123");
    expect(toWhatsAppAddress(phone)).toBe("whatsapp:+447700900123");
    expect(fromWhatsAppAddress(toWhatsAppAddress(phone))).toBe(phone);
  });

  it("does not double-prefix", () => {
    const address = toWhatsAppAddress(normalizePhone("whatsapp:+447700900123"));
    expect(address).toBe("whatsapp:+447700900123");
  });
});

describe("maskPhone", () => {
  it("keeps enough to identify, hides enough to be safe", () => {
    expect(maskPhone("+447700900123")).toBe("+4477****0123");
  });

  it("fully masks implausibly short input", () => {
    expect(maskPhone("+4477")).toBe("****");
  });
});
