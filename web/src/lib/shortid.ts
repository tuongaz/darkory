/**
 * Darkory's ids in their short form (ADR 0017), the twin of the server's internal/shortid.
 *
 * Every id is a UUID. The API writes it as 22 characters of base58 (the Bitcoin alphabet, in ASCII
 * order): the UUID's 128 bits as one number, left-padded with "1". The web app shows ids as the
 * API gives them and needs this only to read an id from an address that may predate short ids:
 * an old link carries the UUID's 36-character text, which `toShort` turns into the id the API
 * writes, so it compares equal.
 */

export const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const SHORT_LENGTH = 22;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHORT = /^[1-9A-HJ-NP-Za-km-z]{22}$/;
const MAX = (1n << 128n) - 1n;
const B58 = 58n;

function encode(n: bigint): string {
  let out = "";
  for (let i = 0; i < SHORT_LENGTH; i++) {
    out = ALPHABET[Number(n % B58)] + out;
    n /= B58;
  }
  return out;
}

function decode(s: string): bigint | undefined {
  if (!SHORT.test(s)) return undefined;
  let n = 0n;
  for (const c of s) n = n * B58 + BigInt(ALPHABET.indexOf(c));
  return n <= MAX ? n : undefined;
}

function uuidText(n: bigint): string {
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Whether s is an id in either form. */
export function isId(s: string): boolean {
  return UUID.test(s) || decode(s) !== undefined;
}

/** The short form of an id given in either form; anything else unchanged. */
export function toShort(s: string): string {
  if (UUID.test(s)) return encode(BigInt(`0x${s.replaceAll("-", "")}`));
  return s;
}

/** The UUID's canonical text of an id given in either form; anything else unchanged. */
export function toUuid(s: string): string {
  if (UUID.test(s)) return s.toLowerCase();
  const n = decode(s);
  return n === undefined ? s : uuidText(n);
}
