globalThis.__nitro_main__ = import.meta.url;
import { H3Core, HTTPError, NodeResponse, createMatcherFromFind, defineHandler, defineLazyEventHandler, memoizeRouteRulesMatcher, toEventHandler } from "./_libs/h3+rou3+srvx.mjs";
import { unit } from "./_chunks/runtime.mjs";
//#region .agent-unit/entry.mjs
var entry_default = defineHandler((event) => unit.handler(event.req, { waitUntil: (promise) => event.waitUntil(promise) }));
//#endregion
//#region #nitro/virtual/routing
const findRouteRules = (m, p) => {
	return [];
};
const _lazy_2691c0c67880222b = defineLazyEventHandler(() => import("./_chunks/cron-handler.mjs").then((n) => n.cron_handler_exports));
const findRoute = /* @__PURE__ */ (() => {
	const $0 = {
		route: "/_vercel/cron",
		handler: _lazy_2691c0c67880222b
	}, $1 = {
		route: "/**",
		handler: toEventHandler(entry_default)
	};
	return (m, p) => {
		if (p.charCodeAt(p.length - 1) === 47) p = p.slice(0, -1);
		if (p === "/_vercel/cron") return { data: $0 };
		else if (p.charCodeAt(p.length - 1) === 47) {
			if (p === "/_vercel/cron/") return { data: $0 };
		}
		let s = p.split("/");
		if (s.length > 1 && s[s.length - 1] === "") {
			s.pop();
			p = p.slice(0, -1);
		}
		s.length;
		return {
			data: $1,
			params: { "_": p.slice(1) }
		};
	};
})();
[].filter(Boolean);
//#endregion
//#region ../../../../node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/runtime/internal/error/prod.mjs
const errorHandler = (error, event) => {
	const res = defaultHandler(error, event);
	return new NodeResponse(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2), res);
};
function defaultHandler(error, event) {
	const unhandled = error.unhandled ?? !HTTPError.isError(error);
	const { status = 500, statusText = "" } = unhandled ? {} : error;
	if (status === 404) {
		const url = event.url || new URL(event.req.url);
		const baseURL = "/";
		if (/^\/[^/]/.test(baseURL) && !url.pathname.startsWith(baseURL)) return {
			status: 302,
			headers: new Headers({ location: `${baseURL}${url.pathname.slice(1)}${url.search}` })
		};
	}
	const headers = new Headers(unhandled ? {} : error.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return {
		status,
		statusText,
		headers,
		body: {
			error: true,
			...unhandled ? {
				status,
				unhandled: true
			} : typeof error.toJSON === "function" ? error.toJSON() : {
				status,
				statusText,
				message: error.message
			}
		}
	};
}
//#endregion
//#region #nitro/virtual/error-handler
const errorHandlers = [errorHandler];
async function error_handler_default(error, event) {
	for (const handler of errorHandlers) try {
		const response = await handler(error, event, { defaultHandler });
		if (response) return response;
	} catch (error) {
		console.error(error);
	}
}
//#endregion
//#region #nitro/virtual/app
function createNitroApp() {
	const captureError = (error, errorCtx) => {
		if (errorCtx?.event) {
			const errors = errorCtx.event.req.context?.nitro?.errors;
			if (errors) errors.push({
				error,
				context: errorCtx
			});
		}
	};
	const h3App = createH3App({ onError(error, event) {
		return error_handler_default(error, event);
	} });
	let appHandler = (req) => {
		req.context ||= {};
		req.context.nitro = req.context.nitro || { errors: [] };
		return h3App.fetch(req);
	};
	return {
		fetch: appHandler,
		h3: h3App,
		hooks: void 0,
		captureError
	};
}
function createH3App(config) {
	const h3App = new H3Core(config);
	h3App["~findRoute"] = (event) => {
		return findRoute(event.req.method, event.url.pathname);
	};
	return h3App;
}
//#endregion
//#region ../../../../node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/runtime/internal/app.mjs
const APP_ID = "default";
function useNitroApp() {
	let instance = useNitroApp._instance;
	if (instance) return instance;
	instance = useNitroApp._instance = createNitroApp();
	globalThis.__nitro__ = globalThis.__nitro__ || {};
	globalThis.__nitro__[APP_ID] = instance;
	return instance;
}
let _matchRouteRules;
function getRouteRules(method, pathname) {
	return (_matchRouteRules ??= memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules)))(method, pathname);
}
function isrRouteRewrite(reqUrl, xNowRouteMatches) {
	const queryIndex = reqUrl.indexOf("?");
	const reqParams = queryIndex === -1 ? new URLSearchParams() : new URLSearchParams(reqUrl.slice(queryIndex + 1));
	const isrURL = xNowRouteMatches ? new URLSearchParams(xNowRouteMatches).get("__isr_route") : reqParams.get("__isr_route");
	if (!isrURL) return;
	reqParams.delete("__isr_route");
	return [isrURL, reqParams.toString()];
}
//#endregion
//#region ../../../../node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/presets/vercel/runtime/vercel.web.mjs
const nitroApp = useNitroApp();
var vercel_web_default = { async fetch(req, context) {
	const isrURL = isrRouteRewrite(req.url, req.headers.get("x-now-route-matches"));
	if (isrURL) {
		const { routeRules } = getRouteRules("", isrURL[0]);
		if (routeRules?.isr) req = new Request(new URL(isrURL[0] + (isrURL[1] ? `?${isrURL[1]}` : ""), req.url).href, req);
	}
	req.runtime ??= { name: "vercel" };
	req.runtime.vercel = { context };
	let ip;
	Object.defineProperty(req, "ip", { get() {
		const h = req.headers.get("x-forwarded-for");
		return ip ??= h?.split(",").shift()?.trim();
	} });
	req.waitUntil = context?.waitUntil;
	return nitroApp.fetch(req);
} };
//#endregion
export { vercel_web_default as default };
