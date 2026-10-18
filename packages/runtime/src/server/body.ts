import { AgentUnitError } from "../runtime/engine";

const DEFAULT_MAX_BODY = 1024 * 1024;
const JSON_TYPE = /^application\/([\w.+-]+\+)?json\b/i;

/**
 * Refuses a POST that a page on another site could send without the browser asking first: an HTML
 * form or a plain `fetch` can only send form encodings, text/plain or no content type, with the
 * visitor's cookies. When `authorize` relies on cookies, such a request could start, resume or
 * cancel a run, body or not. So a POST's content type, when it has one, must be JSON, and one with
 * none must not come from another site by the browser's own account (`Sec-Fetch-Site`, which
 * clients outside a browser do not send).
 */
export function checkPost(request: Request): void {
  const type = request.headers.get("content-type");
  if (type !== null && !JSON_TYPE.test(type)) throw new AgentUnitError(415, "unsupported_media_type", "Send the request body as application/json.");
  const site = request.headers.get("sec-fetch-site");
  if (type === null && (site === "cross-site" || site === "same-site")) {
    throw new AgentUnitError(415, "unsupported_media_type", "A POST from another site must have Content-Type: application/json.");
  }
}

/**
 * A request body as text, refused when it is too large or not JSON (see `checkPost` for why the
 * type matters even without a body).
 */
export async function readBody(request: Request, maxBytes = DEFAULT_MAX_BODY): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (declared > maxBytes) throw new AgentUnitError(413, "body_too_large", `The request body is larger than ${maxBytes} bytes.`);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AgentUnitError(413, "body_too_large", `The request body is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  const type = request.headers.get("content-type") ?? "";
  if (text.trim() && !JSON_TYPE.test(type)) {
    throw new AgentUnitError(415, "unsupported_media_type", "Send the request body as application/json.");
  }
  return text;
}
