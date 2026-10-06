import { unit } from "../_chunks/runtime.mjs";
import { defineTask } from "../_chunks/cron-handler.mjs";
//#region .agent-unit/sweep.mjs
var sweep_default = defineTask({
	meta: { description: "Wake due agent-unit runs and recover stalled ones." },
	async run() {
		const { woken, recovered, settled } = await unit.engine.sweep();
		await settled;
		return { result: {
			woken,
			recovered
		} };
	}
});
//#endregion
export { sweep_default as default };
