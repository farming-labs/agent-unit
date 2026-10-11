import { AgentUnitError } from "../runtime/engine";

const DEFAULT_MAX_BODY = 1024 * 1024;

/**
 * A request body as text, refused when it is too large or not JSON. Requiring a JSON content type
 * also means a cross-site HTML form (which can only send form encodings or text/plain) can never
 * start or resume a run on a visitor's behalf when `authorize` relies on cookies.
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
  if (text.trim() && !/^application\/([\w.+-]+\+)?json\b/i.test(type)) {
    throw new AgentUnitError(415, "unsupported_media_type", "Send the request body as application/json.");
  }
  return text;
}
