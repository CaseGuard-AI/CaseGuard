// Reading an upload (FR-DOC-1, SEC-6): one `file` part of a multipart body, at most `maxBytes`,
// its type found from the content alone. Nothing here processes the file.
import busboy from "busboy";
import type { Request, Response } from "express";
import { fileTypeFromBuffer } from "file-type";
import { DOCUMENT_MEDIA_TYPES, type DocumentMediaType } from "../clients/ai.js";
import { HttpProblem } from "../lib/problem.js";

export interface Upload {
  filename: string;
  data: Buffer;
}

const badRequest = (message: string, path = "file") =>
  new HttpProblem(400, "Bad Request", "The upload is not valid.", {
    errors: [{ path, message }],
  });

/**
 * The original filename without any directory or control characters, at most 255 characters
 * (api.v1 uploadDocument). Never used as a path: it lives only in the database.
 */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[/\\]/).at(-1) ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return Array.from(clean).slice(0, 255).join("") || "document";
}

/** The sniffed type if it is one we accept (DocumentMediaType), else undefined (415). */
export async function sniffMediaType(data: Buffer): Promise<DocumentMediaType | undefined> {
  const mime = (await fileTypeFromBuffer(data))?.mime;
  return DOCUMENT_MEDIA_TYPES.find((t) => t === mime);
}

/**
 * Reads the body into memory (at most 25 MB). A larger file is cut off and answered 413: the
 * rest of the body is discarded and the connection closed after the response.
 */
export function readUpload(req: Request, res: Response, maxBytes: number): Promise<Upload> {
  if (!req.is("multipart/form-data")) {
    return Promise.reject(badRequest("Send the file as multipart/form-data."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let upload: Upload | undefined;
    let pending: Promise<void> | undefined;

    const stop = (err: Error) => {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      req.resume();
      res.setHeader("Connection", "close");
      reject(err);
    };

    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        // A second file or any field is reported by filesLimit / fieldsLimit.
        limits: { files: 1, fields: 0, fileSize: maxBytes },
      });
    } catch {
      reject(badRequest("The multipart body is malformed."));
      return;
    }

    parser.on("file", (name, stream, info) => {
      if (name !== "file") {
        stream.resume();
        return stop(badRequest(`Unexpected part "${name}". Send only "file".`, name));
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () =>
        stop(
          new HttpProblem(413, "Payload Too Large", `The file is larger than ${maxBytes} bytes.`),
        ),
      );
      pending = new Promise((done) =>
        stream.on("end", () => {
          if (!stream.truncated) {
            upload = { filename: info.filename ?? "", data: Buffer.concat(chunks) };
          }
          done();
        }),
      );
    });
    parser.on("field", (name) =>
      stop(badRequest(`Unexpected field "${name}". Send only "file".`, name)),
    );
    for (const event of ["filesLimit", "fieldsLimit"] as const) {
      parser.on(event, () => stop(badRequest('Send exactly one part, "file".')));
    }
    parser.on("error", () => stop(badRequest("The multipart body is malformed.")));
    parser.on("close", () => {
      void (pending ?? Promise.resolve()).then(() => {
        if (settled) return;
        settled = true;
        if (!upload) return reject(badRequest('The "file" part is missing.'));
        if (!upload.filename) return reject(badRequest("The file part needs a filename."));
        if (upload.data.length === 0) return reject(badRequest("The file is empty."));
        resolve(upload);
      });
    });
    req.pipe(parser);
  });
}
