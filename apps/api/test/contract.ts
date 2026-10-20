// Contract checks against packages/contracts/openapi/api.v1.yaml: a response must use a status
// the operation declares, with that response's content type and a body matching its schema.
import { fileURLToPath } from "node:url";
import { dereference } from "@apidevtools/json-schema-ref-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Response } from "supertest";
import { expect } from "vitest";

const SPEC = fileURLToPath(
  new URL("../../../packages/contracts/openapi/api.v1.yaml", import.meta.url),
);

interface MediaType {
  schema?: object;
}
interface ResponseSpec {
  content?: Record<string, MediaType>;
}
interface Spec {
  paths: Record<string, Record<string, { responses: Record<string, ResponseSpec> }>>;
}

const spec = (await dereference(SPEC)) as unknown as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

export function expectContract(res: Response, method: string, path: string) {
  const operation = spec.paths[path]?.[method.toLowerCase()];
  if (!operation) throw new Error(`${method} ${path} is not in api.v1.yaml`);
  const declared = operation.responses[String(res.status)];
  expect(declared, `${method} ${path} does not declare status ${res.status}`).toBeDefined();
  const content = declared!.content;
  if (!content) {
    expect(res.text ?? "").toBe("");
    return;
  }
  const [mediaType, media] = Object.entries(content)[0]!;
  expect(res.headers["content-type"]).toContain(mediaType);
  if (media.schema) {
    const validate = ajv.compile(media.schema);
    const ok = validate(res.body);
    expect(ok, `${method} ${path} ${res.status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
}
