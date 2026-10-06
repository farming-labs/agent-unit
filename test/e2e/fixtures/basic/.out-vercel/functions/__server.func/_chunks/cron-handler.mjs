import { __exportAll } from "../_runtime.mjs";
import { HTTPError, defineHandler } from "../_libs/h3+rou3+srvx.mjs";
import { timingSafeEqual } from "node:crypto";
//#region #nitro/virtual/tasks
const scheduledTasks = [{
	"cron": "* * * * *",
	"tasks": ["agent-unit:sweep"]
}];
const tasks = { "agent-unit:sweep": {
	meta: { description: "Wake due runs and recover stalled ones." },
	resolve: () => import("../_tasks/sweep.mjs").then((r) => r.default || r)
} };
//#endregion
//#region ../../../../node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/runtime/internal/task.mjs
function defineTask(def) {
	if (typeof def.run !== "function") def.run = () => {
		throw new TypeError("Task must implement a `run` method!");
	};
	return def;
}
const __runningTasks__ = {};
async function runTask(name, { payload = {}, context = {} } = {}) {
	if (__runningTasks__[name]) return __runningTasks__[name];
	if (!(name in tasks)) throw new HTTPError({
		message: `Task \`${name}\` is not available!`,
		status: 404
	});
	if (!tasks[name].resolve) throw new HTTPError({
		message: `Task \`${name}\` is not implemented!`,
		status: 501
	});
	const handler = await tasks[name].resolve();
	const taskEvent = {
		name,
		payload,
		context
	};
	__runningTasks__[name] = handler.run(taskEvent);
	try {
		return await __runningTasks__[name];
	} finally {
		delete __runningTasks__[name];
	}
}
function getCronTasks(cron) {
	return (scheduledTasks || []).find((task) => task.cron === cron)?.tasks || [];
}
function runCronTasks(cron, ctx) {
	return Promise.all(getCronTasks(cron).map((name) => runTask(name, ctx)));
}
//#endregion
//#region ../../../../node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/presets/vercel/runtime/cron-handler.mjs
var cron_handler_exports = /* @__PURE__ */ __exportAll({ default: () => cron_handler_default });
var cron_handler_default = defineHandler(async (event) => {
	const cronSecret = process.env.CRON_SECRET;
	if (cronSecret) {
		const authHeader = event.req.headers.get("authorization") || "";
		const expected = `Bearer ${cronSecret}`;
		const a = Buffer.from(authHeader);
		const b = Buffer.from(expected);
		if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HTTPError("Unauthorized", { status: 401 });
	}
	const cron = event.req.headers.get("x-vercel-cron-schedule");
	if (!cron) throw new HTTPError("Missing x-vercel-cron-schedule header", { status: 400 });
	await runCronTasks(cron, {
		context: { waitUntil: event.req.waitUntil },
		payload: { scheduledTime: Date.now() }
	});
	return { success: true };
});
//#endregion
export { cron_handler_exports, cron_handler_default as default, defineTask };
