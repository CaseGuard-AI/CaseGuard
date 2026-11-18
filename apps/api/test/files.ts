// Tiny files of each accepted type (FR-DOC-1), just enough for content sniffing.
import { crc32 } from "node:zlib";

/** A zip with stored (uncompressed) entries. */
export function zip(entries: [name: string, text: string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

export const FILES = {
  "application/pdf": Buffer.from(
    "%PDF-1.4\n%\xE2\xE3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
    "latin1",
  ),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": zip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["word/document.xml", "<w:document/>"],
  ]),
  "image/png": Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082",
    "hex",
  ),
  "image/jpeg": Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"),
  "image/tiff": Buffer.concat([Buffer.from("49492a0008000000", "hex"), Buffer.alloc(16)]),
} as const;

export const PDF = FILES["application/pdf"];
