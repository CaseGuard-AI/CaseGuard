import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanFilename, sniffMediaType } from "../src/documents/upload.js";
import { contentDisposition } from "../src/routes/documents.js";
import { BlobNotFound, createFsBlobStore, documentKey } from "../src/storage/blob-store.js";
import { FILES, zip } from "./files.js";

const U = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const D = "33333333-3333-4333-8333-333333333333";

describe("cleanFilename", () => {
  it.each([
    ["FIR 112-2026.pdf", "FIR 112-2026.pdf"],
    ["C:\\Users\\a\\FIR.pdf", "FIR.pdf"],
    ["../../etc/passwd", "passwd"],
    ["FIR\u0000\u0007\u001f\u007f.pdf", "FIR.pdf"],
    ["  spaced.pdf  ", "spaced.pdf"],
    ["", "document"],
    ["dir/", "document"],
    ["مقدمہ.pdf", "مقدمہ.pdf"],
  ])("%j -> %j", (raw, clean) => expect(cleanFilename(raw)).toBe(clean));

  it("keeps at most 255 characters, counting code points", () => {
    expect(cleanFilename("a".repeat(300))).toHaveLength(255);
    expect(Array.from(cleanFilename("😀".repeat(300)))).toHaveLength(255);
  });
});

describe("contentDisposition", () => {
  it("an ASCII fallback with quotes and backslashes replaced, plus the exact UTF-8 name", () => {
    expect(contentDisposition('Ürdu "FIR"\\1.pdf')).toBe(
      "attachment; filename=\"_rdu _FIR__1.pdf\"; filename*=UTF-8''%C3%9Crdu%20%22FIR%22%5C1.pdf",
    );
    expect(contentDisposition("it's (1).pdf")).toBe(
      "attachment; filename=\"it's (1).pdf\"; filename*=UTF-8''it%27s%20%281%29.pdf",
    );
  });
});

describe("sniffMediaType (FR-DOC-1)", () => {
  it.each(Object.entries(FILES))("accepts %s", async (type, data) => {
    expect(await sniffMediaType(data)).toBe(type);
  });

  it.each([
    ["a plain zip", zip([["a.txt", "hello"]])],
    ["text", Buffer.from("just some text")],
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
  ])("rejects %s", async (_, data) => {
    expect(await sniffMediaType(data)).toBeUndefined();
  });
});

describe("fs blob store (data-storage §6)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cg-blobs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("puts, gets and deletes by key; deletes are idempotent", async () => {
    const store = createFsBlobStore(root);
    const key = documentKey(U, C, D);
    expect(key).toBe(`users/${U}/cases/${C}/${D}`);
    await store.put(key, Buffer.from("hello"));
    expect(await text(await store.get(key))).toBe("hello");
    expect(await readdir(join(root, "users", U, "cases", C))).toEqual([D]);
    await store.delete(key);
    await store.delete(key);
    await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFound);
  });

  it("deletePrefix removes everything under it", async () => {
    const store = createFsBlobStore(root);
    await store.put(documentKey(U, C, D), Buffer.from("a"));
    await store.put(documentKey(U, D, C), Buffer.from("b"));
    await store.deletePrefix(`users/${U}`);
    expect(await readdir(join(root, "users"))).toEqual([]);
    await store.deletePrefix(`users/${U}`);
  });

  it.each(["../escape", "users/../../x", "/abs", "users//x", "Users/X", "a b"])(
    "refuses the key %j",
    async (key) => {
      const store = createFsBlobStore(root);
      await expect(store.put(key, Buffer.from("x"))).rejects.toThrow(/Invalid blob key/);
    },
  );
});
