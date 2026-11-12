// AES-256-GCM for users' provider keys (FR-SET-2, SEC-4, ADR-0009). A random 12-byte IV for
// every write; the 16-byte auth tag is stored and checked on decrypt, so a changed ciphertext,
// IV, tag, AAD or key throws instead of returning garbage.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function checkKey(key: Buffer) {
  if (key.length !== 32) throw new Error("The encryption key must be 32 bytes");
}

/**
 * Encrypts `plain` under `key` (32 bytes). `aad`, if given, binds the ciphertext to a context
 * (for example the owner and provider), and the same `aad` must be passed to decrypt.
 */
export function encrypt(plain: string, key: Buffer, aad?: string): Sealed {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Decrypts what `encrypt` sealed. Throws if anything was tampered with or the key is wrong. */
export function decrypt(sealed: Sealed, key: Buffer, aad?: string): string {
  checkKey(key);
  if (sealed.iv.length !== IV_BYTES || sealed.authTag.length !== TAG_BYTES) {
    throw new Error("Malformed sealed value");
  }
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}
