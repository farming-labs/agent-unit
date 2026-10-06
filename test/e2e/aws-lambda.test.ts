import { describe } from "vitest";
import { serverlessSuite } from "./serverless";

/** An API Gateway HTTP API (payload v2) event for a Web request. */
async function toLambdaEvent(request: Request) {
  const url = new URL(request.url);
  const body = request.body ? await request.text() : undefined;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(request.headers),
    requestContext: {
      domainName: url.host,
      http: { method: request.method, path: url.pathname, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "e2e" },
      requestId: crypto.randomUUID(),
      stage: "$default",
    },
    body,
    isBase64Encoded: false,
  };
}

describe("aws-lambda function", () => {
  serverlessSuite({
    preset: "aws-lambda",
    entry: "server/index.mjs",
    waitUntil: false,
    async invoke(module, request) {
      const result = await module.handler(await toLambdaEvent(request), { awsRequestId: crypto.randomUUID() });
      const body = result.isBase64Encoded ? Buffer.from(result.body ?? "", "base64") : (result.body ?? "");
      const headers = new Headers(result.headers);
      for (const cookie of result.cookies ?? []) headers.append("set-cookie", cookie);
      return new Response(result.statusCode === 204 ? null : body, { status: result.statusCode, headers });
    },
  });
});
