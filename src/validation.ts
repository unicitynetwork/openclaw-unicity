/** Shared validation helpers: nametags, tool recipients, group ids and channel targets. */

import { isValidNametag } from "@unicitylabs/sphere-sdk";

/** Plain nametag charset or an E.164 phone nametag; keeps sender-asserted text out of headers. */
const NAMETAG_CHARSET = /^(?:[a-z0-9_-]{3,20}|\+[1-9][0-9]{6,14})$/;

/** Nametag syntax accepted by the SDK (delegates to sphere-sdk isValidNametag after normalizing: trim, strip '@', lowercase). */
export function normalizeNametag(input: string): string | null {
  const n = input.trim().replace(/^@/, "").trim().toLowerCase();
  return NAMETAG_CHARSET.test(n) && isValidNametag(n) ? n : null;
}

/** Recipient accepted by tools: @nametag | bare nametag | 64-hex x-only | 66-hex 02/03 chain key | DIRECT://... (no PROXY:). */
export const VALID_RECIPIENT =
  /^(?:@?[A-Za-z0-9_-]{3,20}|@?\+[1-9][0-9]{6,14}|(?:0[23])?[0-9a-fA-F]{64}|DIRECT:\/\/[0-9a-fA-F]{16,})$/;

export function validateRecipient(recipient: string): void {
  const r = recipient.trim();
  if (VALID_RECIPIENT.test(r)) return;
  if (/^PROXY:/i.test(r)) {
    throw new Error(`Invalid recipient "${recipient}": PROXY addresses are not supported. Use a @nametag, public key or DIRECT:// address.`);
  }
  throw new Error(
    `Invalid recipient "${recipient}". Expected a @nametag, a 64-hex public key, a 66-hex chain public key (02/03…), or a DIRECT:// address.`,
  );
}

/** Group ids the SDK creates: `<slug≤24>-<16hex>`. */
export const SLUG_GROUP_ID = /^[a-z0-9-]{1,24}-[0-9a-f]{16}$/;
/** Short alphanumeric group ids (≤20 chars). */
export const SHORT_GROUP_ID = /^[A-Za-z0-9]{1,20}$/;

/** Group ids: `<slug≤24>-<16hex>` ids and short alphanumeric ones. */
export function isGroupId(s: string): boolean {
  return SHORT_GROUP_ID.test(s) || SLUG_GROUP_ID.test(s);
}

/** Channel target: recipient OR group id (used by messaging.targetResolver.looksLikeId). */
export function looksLikeTarget(input: string): boolean {
  const t = input.trim();
  return VALID_RECIPIENT.test(t) || isGroupId(t);
}
