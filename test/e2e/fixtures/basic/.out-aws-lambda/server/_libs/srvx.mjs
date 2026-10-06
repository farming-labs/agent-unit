import { HOST_RE, forwardedHopValue, resolveClientIP, trustedHops } from "./h3+rou3+srvx.mjs";
//#region ../../../../node_modules/.pnpm/srvx@1.0.5/node_modules/srvx/dist/adapters/aws-lambda.mjs
function awsRequest(event, context, trustProxy) {
	const sourceIp = awsEventIP(event);
	const forwardedFor = awsForwardedFor(event);
	const hops = trustedHops(trustProxy, sourceIp, forwardedFor);
	const req = new Request(awsEventURL(event, hops), {
		method: awsEventMethod(event),
		headers: awsEventHeaders(event),
		body: awsEventBody(event)
	});
	req.runtime = {
		name: "aws-lambda",
		awsLambda: {
			event,
			context
		}
	};
	req.ip = resolveClientIP(trustProxy, sourceIp, forwardedFor);
	return req;
}
function awsForwardedFor(event) {
	return event.headers["X-Forwarded-For"] || event.headers["x-forwarded-for"];
}
function awsEventMethod(event) {
	return event.httpMethod || event.requestContext?.http?.method || "GET";
}
function awsEventIP(event) {
	return event.requestContext?.http?.sourceIp || event.requestContext?.identity?.sourceIp;
}
function awsEventURL(event, hops) {
	const rawPath = event.path || event.rawPath || "/";
	const path = rawPath[0] === "/" ? rawPath : `/${rawPath}`;
	const query = awsEventQuery(event);
	const forwardedHost = forwardedHopValue(event.headers["X-Forwarded-Host"] || event.headers["x-forwarded-host"], hops);
	const host = (forwardedHost && HOST_RE.test(forwardedHost) ? forwardedHost : void 0) || event.headers.host || event.headers.Host || event.requestContext?.domainName;
	const hostname = host && HOST_RE.test(host) ? host : "_invalid_";
	const protocol = forwardedHopValue(event.headers["X-Forwarded-Proto"] || event.headers["x-forwarded-proto"], hops) === "http" ? "http" : "https";
	return new URL(`${protocol}://${hostname}${path}${query ? `?${query}` : ""}`);
}
function awsEventQuery(event) {
	if (typeof event.rawQueryString === "string") return event.rawQueryString;
	return stringifyQuery({
		...event.queryStringParameters,
		...event.multiValueQueryStringParameters
	});
}
function awsEventHeaders(event) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(event.headers)) if (value) headers.set(key, value);
	const cookies = "cookies" in event && event.cookies?.length ? event.cookies : void 0;
	if (cookies) {
		headers.delete("cookie");
		for (const cookie of cookies) headers.append("cookie", cookie);
	}
	return headers;
}
function awsEventBody(event) {
	if (!event.body) return;
	if (event.isBase64Encoded) return Buffer.from(event.body || "", "base64");
	return event.body;
}
function awsResponseHeaders(response, event) {
	const headers = Object.create(null);
	for (const [key, value] of response.headers) {
		if (key === "set-cookie") continue;
		if (value) headers[key] = Array.isArray(value) ? value.join(",") : String(value);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length === 0) return { headers };
	if (event?.version === "2.0" || !!event?.requestContext?.http) return {
		headers,
		cookies
	};
	const albEvent = event;
	if (albEvent?.requestContext?.elb && !albEvent.multiValueHeaders) {
		headers["set-cookie"] = cookies[cookies.length - 1];
		return { headers };
	}
	return {
		headers,
		multiValueHeaders: { "set-cookie": cookies }
	};
}
async function awsResponseBody(response) {
	if (!response.body) return { body: "" };
	const buffer = await toBuffer(response.body);
	return isTextType(response.headers.get("content-type") || "") ? { body: buffer.toString("utf8") } : {
		body: buffer.toString("base64"),
		isBase64Encoded: true
	};
}
function isTextType(contentType = "") {
	const mimeType = contentType.split(";")[0].trim();
	return /^text\/|\/(javascript|json|xml)|\+(json|xml)$/i.test(mimeType);
}
function toBuffer(data) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		data.pipeTo(new WritableStream({
			write(chunk) {
				chunks.push(chunk);
			},
			close() {
				resolve(Buffer.concat(chunks));
			},
			abort(reason) {
				reject(reason);
			}
		})).catch(reject);
	});
}
function stringifyQuery(obj) {
	const parts = [];
	for (const [key, value] of Object.entries(obj)) for (const item of Array.isArray(value) ? value : [value]) {
		const pair = new URLSearchParams([[key, item == null ? "" : String(item)]]).toString();
		const bare = (item == null || item === "") && key !== "";
		parts.push(bare ? pair.slice(0, -1) : pair);
	}
	return parts.join("&");
}
async function handleLambdaEvent(fetchHandler, event, context, trustProxy) {
	const response = await fetchHandler(awsRequest(event, context, trustProxy));
	return {
		statusCode: response.status,
		...awsResponseHeaders(response, event),
		...await awsResponseBody(response)
	};
}
//#endregion
export { handleLambdaEvent };
