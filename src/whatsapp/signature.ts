// twilio is CommonJS. A named import compiles fine but throws at runtime under
// real ESM ("Named export 'validateRequest' not found"), so go through the
// default export. Vitest's transpilation hides this — only the built artifact
// surfaces it, which is why CI boots dist/.
import twilio from "twilio";

const { validateRequest } = twilio;
import type { FastifyRequest } from "fastify";

/**
 * Rebuilds the exact URL Twilio signed.
 *
 * This is the single most common source of "invalid signature" bugs. Twilio
 * signs the URL *it* called — the one configured in the console — so on Railway
 * or Render, where TLS terminates upstream, deriving the URL from the incoming
 * request yields `http://` and an internal hostname, and every signature fails.
 *
 * Anchoring on the configured PUBLIC_URL removes the guesswork: it is by
 * definition the URL the console points at.
 */
export function reconstructUrl(publicUrl: string, requestUrl: string): string {
  return new URL(requestUrl, publicUrl).toString();
}

export interface VerifySignatureInput {
  authToken: string;
  signature: string | undefined;
  publicUrl: string;
  requestUrl: string;
  params: Record<string, unknown>;
}

export function verifyTwilioSignature({
  authToken,
  signature,
  publicUrl,
  requestUrl,
  params,
}: VerifySignatureInput): boolean {
  if (!signature) return false;

  return validateRequest(
    authToken,
    signature,
    reconstructUrl(publicUrl, requestUrl),
    // Twilio signs the form-encoded body; every value is a string on the wire.
    params as Record<string, string>,
  );
}

export function getSignatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers["x-twilio-signature"];
  return Array.isArray(header) ? header[0] : header;
}
