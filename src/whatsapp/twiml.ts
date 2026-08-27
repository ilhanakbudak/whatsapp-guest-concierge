/**
 * TwiML replies.
 *
 * Twilio accepts a reply two ways: a REST call to the Messages API, or TwiML
 * returned straight from the inbound webhook. The REST path is the better
 * architecture — it decouples answering from the webhook and is the only way to
 * send anything the guest did not just prompt, which broadcasts require.
 *
 * But Twilio trial accounts using "Try out WhatsApp" reject free-form REST sends
 * with error 21654, demanding a ContentSid template, and the Content API needed
 * to create one is itself unavailable on trial accounts. Replying inline with
 * TwiML sidesteps that entirely, which makes the bot fully demonstrable on a
 * free account.
 */

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** A guest message can legitimately contain & or <, which would break the XML. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]!);
}

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function messageTwiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(body)}</Message></Response>`;
}

/**
 * Resolves to the handler's answer, or to `fallback` if it takes too long.
 *
 * Twilio abandons a webhook that does not respond within about fifteen seconds
 * and shows the guest nothing at all. A late answer is worth less than a prompt
 * apology, so the timeout is deliberately below Twilio's.
 */
export async function withReplyTimeout(
  work: Promise<string | null>,
  timeoutMs: number,
  fallback: string,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    const result = await Promise.race([work, timeout]);
    return result ?? "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
