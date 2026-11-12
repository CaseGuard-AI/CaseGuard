import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isBase64Key32, parseEnv } from "../src/config/env.js";
import { modelsFor } from "../src/keys/catalog.js";
import { decrypt, encrypt } from "../src/keys/crypto.js";
import { createLogger } from "../src/lib/logger.js";

// FR-SET-2, SEC-4, ADR-0009: AES-256-GCM for users' provider keys. No database needed.
const KEY = Buffer.alloc(32, 7);
const SECRET = "sk-test-0123456789abcdef";

const flip = (b: Buffer, i = 0) => {
  const copy = Buffer.from(b);
  copy[i] = copy[i]! ^ 0xff;
  return copy;
};

describe("keys/crypto", () => {
  it("round-trips a key", () => {
    expect(decrypt(encrypt(SECRET, KEY), KEY)).toBe(SECRET);
    expect(decrypt(encrypt(SECRET, KEY, "ctx"), KEY, "ctx")).toBe(SECRET);
  });

  it("uses a fresh 12-byte IV for every encrypt", () => {
    const a = encrypt(SECRET, KEY);
    const b = encrypt(SECRET, KEY);
    expect(a.iv).toHaveLength(12);
    expect(a.authTag).toHaveLength(16);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("never contains the plaintext", () => {
    const sealed = encrypt(SECRET, KEY);
    for (const part of [sealed.ciphertext, sealed.iv, sealed.authTag]) {
      expect(part.toString("latin1")).not.toContain(SECRET);
      expect(part.toString("utf8")).not.toContain(SECRET);
    }
  });

  it("throws on a tampered ciphertext, IV or tag", () => {
    const sealed = encrypt(SECRET, KEY);
    expect(() => decrypt({ ...sealed, ciphertext: flip(sealed.ciphertext) }, KEY)).toThrow();
    expect(() => decrypt({ ...sealed, iv: flip(sealed.iv) }, KEY)).toThrow();
    expect(() => decrypt({ ...sealed, authTag: flip(sealed.authTag) }, KEY)).toThrow();
    expect(() => decrypt({ ...sealed, authTag: sealed.authTag.subarray(0, 8) }, KEY)).toThrow();
  });

  it("throws with a wrong key or a different AAD", () => {
    const sealed = encrypt(SECRET, KEY, "user-a:gemini");
    expect(() => decrypt(sealed, Buffer.alloc(32, 8), "user-a:gemini")).toThrow();
    expect(() => decrypt(sealed, KEY, "user-b:gemini")).toThrow();
    expect(() => decrypt(sealed, KEY)).toThrow();
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => encrypt(SECRET, Buffer.alloc(31))).toThrow();
  });
});

describe("KEY_ENCRYPTION_KEY validation", () => {
  const base = {
    API_DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    AI_SERVICE_TOKEN: "t".repeat(16),
    JWT_SECRET: "j".repeat(32),
  };

  it("accepts base64 of exactly 32 bytes", () => {
    const key = randomBytes(32).toString("base64");
    expect(isBase64Key32(key)).toBe(true);
    expect(parseEnv({ ...base, KEY_ENCRYPTION_KEY: key }).KEY_ENCRYPTION_KEY).toBe(key);
  });

  it("treats unset or empty as unset", () => {
    expect(parseEnv(base).KEY_ENCRYPTION_KEY).toBeUndefined();
    expect(parseEnv({ ...base, KEY_ENCRYPTION_KEY: "" }).KEY_ENCRYPTION_KEY).toBeUndefined();
  });

  it.each([
    ["a 31-byte key", randomBytes(31).toString("base64")],
    ["a 33-byte key", randomBytes(33).toString("base64")],
    ["hex", randomBytes(32).toString("hex")],
    ["the old placeholder", "change-me-32-byte-base64-key"],
    ["base64url", "-".repeat(43) + "="],
  ])("rejects %s", (_, value) => {
    expect(isBase64Key32(value)).toBe(false);
    expect(() => parseEnv({ ...base, KEY_ENCRYPTION_KEY: value })).toThrow(/KEY_ENCRYPTION_KEY/);
  });
});

describe("model catalogue", () => {
  it("offers models for every seeded cloud provider and none for ollama or unknown ids", () => {
    for (const id of ["nvidia-nim", "gemini", "groq", "openrouter", "openai", "anthropic"]) {
      expect(modelsFor(id).length).toBeGreaterThan(0);
    }
    expect(modelsFor("ollama")).toEqual([]);
    expect(modelsFor("nope")).toEqual([]);
    expect(modelsFor("__proto__")).toEqual([]);
  });

  it("returns a copy", () => {
    modelsFor("gemini").push("x");
    expect(modelsFor("gemini")).not.toContain("x");
  });
});

describe("logger redaction", () => {
  it("censors apiKey wherever a key can travel", () => {
    let out = "";
    const sink = new Writable({
      write(chunk, _enc, done) {
        out += String(chunk);
        done();
      },
    });
    const logger = createLogger("info", false, sink);
    logger.info({ apiKey: SECRET }, "top");
    logger.info({ req: { body: { apiKey: SECRET } } }, "body");
    logger.info({ credential: { providerId: "gemini", model: "m", apiKey: SECRET } }, "cred");
    logger.info({ request: { credential: { apiKey: SECRET } } }, "nested");
    logger.info({ input: { apiKey: SECRET } }, "any");
    expect(out.split("\n").filter(Boolean)).toHaveLength(5);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[Redacted]");
  });
});
