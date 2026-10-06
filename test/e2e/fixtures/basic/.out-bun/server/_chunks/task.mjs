import { __exportAll } from "../_runtime.mjs";
import { HTTPError } from "../_libs/h3+rou3+srvx.mjs";
import { createStorage, driver, prefixStorage } from "../_libs/unstorage.mjs";
import { E } from "../_libs/croner.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
//#region ../../../../dist/types.mjs
/** Declares a framework adapter. */
function defineAdapter(adapter) {
	return adapter;
}
//#endregion
//#region ../../../../dist/agents.mjs
const AGENT = Symbol.for("agent-unit.agent");
/** An agent written without a framework, as one async function. */
function defineAgent(definition) {
	return {
		...typeof definition === "function" ? { run: definition } : definition,
		[AGENT]: true
	};
}
const functionAdapter = defineAdapter({
	name: "agent-unit",
	match: (value) => typeof value === "object" && value !== null && value[AGENT] === true,
	describe: (agent) => ({
		description: agent.description,
		tools: agent.tools ?? []
	}),
	run: (agent, ctx) => agent.run(ctx.input, ctx.run, ctx)
});
/** Finds the adapter that recognises an agent and builds its manifest card. */
function resolveAgent(name, value, adapters) {
	const candidates = [value];
	if (value && typeof value === "object" && "default" in value) candidates.push(value.default);
	for (const agent of candidates) {
		const resolved = matchAdapter(name, agent, adapters);
		if (resolved) return resolved;
	}
	const agent = candidates.at(-1);
	const kind = agent === null ? "null" : typeof agent === "object" ? agent.constructor?.name ?? "object" : typeof agent;
	throw new Error(`No adapter recognises agent "${name}" (${kind}). Export an agent from a supported framework, wrap it with defineAgent(), or add an adapter in agent-unit.config.ts.`);
}
function matchAdapter(name, agent, adapters) {
	for (const adapter of adapters) {
		if (!adapter.match(agent)) continue;
		const described = adapter.describe?.(agent) ?? {};
		const card = {
			name,
			framework: adapter.name,
			tools: described.tools ?? []
		};
		if (described.description) card.description = described.description;
		if (described.input !== void 0) card.input = described.input;
		return {
			name,
			adapter,
			agent,
			card
		};
	}
}
//#endregion
//#region ../../../../dist/util.mjs
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function randomId(prefix, length = 20) {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += ALPHABET[byte & 31];
	return `${prefix}_${out}`;
}
const UNITS = {
	ms: 1,
	s: 1e3,
	m: 6e4,
	h: 36e5,
	d: 864e5
};
/** Parses `250`, `"250ms"`, `"30s"`, `"5m"`, `"2h"` or `"1d"` into milliseconds. */
function parseDuration(duration) {
	if (typeof duration === "number") {
		if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`Invalid duration: ${duration}`);
		return duration;
	}
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(duration);
	if (!match) throw new RangeError(`Invalid duration "${duration}". Use ms or a value like "30s", "5m", "2h", "1d".`);
	return Number(match[1]) * UNITS[match[2]];
}
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function errorInfo(error) {
	if (error instanceof Error) return {
		name: error.name,
		message: error.message
	};
	return {
		name: "Error",
		message: String(error)
	};
}
/** Collects a value that may be a promise or an async iterable into a final value (the last item). */
async function settle(value) {
	const resolved = await value;
	if (resolved && typeof resolved === "object" && Symbol.asyncIterator in resolved) {
		let last;
		for await (const item of resolved) last = item;
		return last;
	}
	return resolved;
}
//#endregion
//#region ../../../../dist/context.mjs
/**
* Thrown inside a run when it must stop executing now: it was interrupted, put to sleep, yielded
* to a fresh invocation or cancelled. Frameworks may catch it (the AI SDK turns tool errors into
* results), so the engine also records the reason on the run and refuses all further live work.
*/
const HALTED = Symbol.for("agent-unit.halted");
var RunHalted = class extends Error {
	reason;
	[HALTED] = true;
	constructor(reason) {
		super(`agent-unit run halted (${reason})`);
		this.reason = reason;
		this.name = "RunHalted";
	}
	static [Symbol.hasInstance](value) {
		return typeof value === "object" && value !== null && value[HALTED] === true;
	}
};
const STORAGE = Symbol.for("agent-unit.context");
const storage = globalThis[STORAGE] ??= new AsyncLocalStorage();
function runWithContext(context, fn) {
	return storage.run(context, fn);
}
/** The current run. Throws outside a run. */
function useRun() {
	const context = storage.getStore();
	if (!context) throw new Error("useRun() was called outside an agent-unit run.");
	return context;
}
/** @internal */
function currentInternals() {
	return storage.getStore();
}
//#endregion
//#region ../../../../dist/durable.mjs
function stringify(value) {
	try {
		return JSON.stringify(value ?? null);
	} catch {
		return JSON.stringify(String(value));
	}
}
/** Emits AG-UI text events for AI SDK stream parts. */
function textEvents(run, key) {
	const open = /* @__PURE__ */ new Set();
	const messageId = (id = "0") => `${key}:${id}`;
	return {
		part(part) {
			if (part.type === "text-start") {
				open.add(messageId(part.id));
				run.emitEvent({
					type: "TEXT_MESSAGE_START",
					messageId: messageId(part.id),
					role: "assistant"
				});
			} else if (part.type === "text-delta" && part.delta) {
				if (!open.has(messageId(part.id))) this.part({
					type: "text-start",
					id: part.id
				});
				run.emitEvent({
					type: "TEXT_MESSAGE_CONTENT",
					messageId: messageId(part.id),
					delta: part.delta
				});
			} else if (part.type === "text-end" && open.delete(messageId(part.id))) run.emitEvent({
				type: "TEXT_MESSAGE_END",
				messageId: messageId(part.id)
			});
		},
		close() {
			for (const id of open) run.emitEvent({
				type: "TEXT_MESSAGE_END",
				messageId: id
			});
			open.clear();
		}
	};
}
function streamFromParts(parts) {
	return new ReadableStream({ start(controller) {
		for (const part of parts) controller.enqueue(part);
		controller.close();
	} });
}
function isProviderModel(value) {
	return typeof value === "object" && value !== null && typeof value.doGenerate === "function" && typeof value.doStream === "function";
}
const wrappedModels = /* @__PURE__ */ new WeakMap();
/** Wraps an AI SDK provider model so every call is a journaled step that streams text events. */
function durableModel(model) {
	if (!isProviderModel(model)) return model;
	const cached = wrappedModels.get(model);
	if (cached) return cached;
	const wrapped = Object.create(model, {
		doGenerate: { value: async (options) => {
			const run = currentInternals();
			if (!run) return model.doGenerate(options);
			const key = run.allocate("model");
			const { value, replayed } = await run.durableCall(key, async () => await model.doGenerate(options), { journalErrors: false });
			if (!replayed) {
				const events = textEvents(run, key);
				(value.content ?? []).forEach((part, index) => {
					if (part.type !== "text" || !part.text) return;
					events.part({
						type: "text-delta",
						id: String(index),
						delta: part.text
					});
				});
				events.close();
			}
			return value;
		} },
		doStream: { value: async (options) => {
			const run = currentInternals();
			if (!run) return model.doStream(options);
			const key = run.allocate("model");
			const replayed = run.readStep(key);
			if (replayed) {
				const stored = replayed.value;
				return {
					stream: streamFromParts(stored.parts),
					response: stored.response
				};
			}
			await run.assertLive();
			const result = await model.doStream(options);
			const parts = [];
			const events = textEvents(run, key);
			const stream = result.stream.pipeThrough(new TransformStream({
				transform(part, controller) {
					parts.push(part);
					events.part(part);
					controller.enqueue(part);
				},
				async flush() {
					events.close();
					if (!parts.some((part) => part.type === "error")) await run.record(key, {
						parts,
						response: result.response
					});
				}
			}));
			return {
				...result,
				stream
			};
		} }
	});
	wrappedModels.set(model, wrapped);
	return wrapped;
}
/** Wraps one tool function so each call is a journaled step that emits AG-UI tool events. */
function durableTool(name, execute, options = {}) {
	return async (...args) => {
		const run = currentInternals();
		if (!run) return await execute(...args);
		const callId = options.toolCallId?.(...args);
		const key = callId ? `tool:${name}:${callId}` : run.allocate(`tool:${name}`);
		const toolCallId = callId ?? key;
		let started = false;
		try {
			const { value, replayed } = await run.durableCall(key, async () => {
				started = true;
				const announced = `${key}:announced`;
				if (!run.isReplay(announced)) {
					run.emitEvent({
						type: "TOOL_CALL_START",
						toolCallId,
						toolCallName: name
					});
					run.emitEvent({
						type: "TOOL_CALL_ARGS",
						toolCallId,
						delta: stringify(args[0])
					});
					run.emitEvent({
						type: "TOOL_CALL_END",
						toolCallId
					});
					await run.record(announced, true);
				}
				return await execute(...args);
			});
			if (!replayed) run.emitEvent({
				type: "TOOL_CALL_RESULT",
				toolCallId,
				content: stringify(value)
			});
			return value;
		} catch (error) {
			if (started && !(error instanceof RunHalted)) run.emitEvent({
				type: "TOOL_CALL_RESULT",
				toolCallId,
				content: stringify({ error: error instanceof Error ? error.message : String(error) })
			});
			throw error;
		}
	};
}
/** Wraps every tool in a record that has an `execute` function. */
function durableTools(tools) {
	if (!tools || typeof tools !== "object") return tools;
	const out = {};
	for (const [name, tool] of Object.entries(tools)) {
		const execute = tool?.execute;
		if (typeof execute !== "function") {
			out[name] = tool;
			continue;
		}
		const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
		copy.execute = durableTool(name, execute.bind(tool), { toolCallId: (_input, callOptions) => callOptions?.toolCallId });
		out[name] = copy;
	}
	return out;
}
function durableStep(name, fn) {
	const run = currentInternals();
	if (!run) return Promise.resolve(fn());
	return run.durableCall({ name: `step:${name}` }, fn).then((result) => result.value);
}
function createDurable() {
	return {
		step: durableStep,
		model: durableModel,
		tools: durableTools,
		tool: durableTool
	};
}
//#endregion
//#region ../../../../dist/store.mjs
/** Events after which a stream ends: the run finished or parked. */
const SETTLING_EVENTS = /* @__PURE__ */ new Set([
	"RUN_FINISHED",
	"RUN_ERROR",
	"RUN_INTERRUPTED",
	"RUN_SLEEPING",
	"RUN_CANCELLED"
]);
const TAG = "$au";
function toBase64(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
function fromBase64(text) {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
/** Converts a value into plain JSON data, tagging the types JSON cannot hold. */
function encode(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === void 0) return { [TAG]: "undefined" };
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return {
		[TAG]: "BigInt",
		v: value.toString()
	};
	if (typeof value === "function" || typeof value === "symbol") return { [TAG]: "undefined" };
	if (value instanceof Date) return {
		[TAG]: "Date",
		v: value.toISOString()
	};
	if (value instanceof Uint8Array) return {
		[TAG]: "Uint8Array",
		v: toBase64(value)
	};
	if (value instanceof Error) return {
		[TAG]: "Error",
		v: {
			name: value.name,
			message: value.message,
			stack: value.stack
		}
	};
	const object = value;
	if (seen.has(object)) throw new TypeError("agent-unit cannot store circular values");
	seen.add(object);
	try {
		if (value instanceof Map) return {
			[TAG]: "Map",
			v: [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)])
		};
		if (value instanceof Set) return {
			[TAG]: "Set",
			v: [...value].map((v) => encode(v, seen))
		};
		if (Array.isArray(value)) return value.map((item) => encode(item, seen));
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			if (item === void 0 || typeof item === "function" || typeof item === "symbol") continue;
			out[key] = encode(item, seen);
		}
		return out;
	} finally {
		seen.delete(object);
	}
}
/** Restores a value produced by `encode`. */
function decode(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(decode);
	const record = value;
	if (typeof record[TAG] === "string") {
		const tagged = record;
		switch (tagged[TAG]) {
			case "undefined": return;
			case "Date": return new Date(tagged.v);
			case "BigInt": return BigInt(tagged.v);
			case "Map": return new Map(tagged.v.map(([k, v]) => [decode(k), decode(v)]));
			case "Set": return new Set(tagged.v.map(decode));
			case "Uint8Array": return fromBase64(tagged.v);
			case "Error": {
				const error = new Error(tagged.v.message);
				error.name = tagged.v.name;
				if (tagged.v.stack) error.stack = tagged.v.stack;
				return error;
			}
		}
	}
	const out = {};
	for (const [key, item] of Object.entries(record)) out[key] = decode(item);
	return out;
}
/** A JSON-safe copy of a value: what a reader of the stored data will see. */
function toJsonSafe(value) {
	return JSON.parse(JSON.stringify(value ?? null));
}
var AgentUnitError = class extends Error {
	status;
	code;
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
		this.name = "AgentUnitError";
	}
};
const TERMINAL = /* @__PURE__ */ new Set([
	"completed",
	"failed",
	"cancelled"
]);
const MAX_LOCAL_SLEEP_MS = 9e5;
var RunExecution = class {
	engine;
	run;
	journal;
	counters = /* @__PURE__ */ new Map();
	pending = [];
	flushing = Promise.resolve();
	lastRemoteCheck = 0;
	controller = new AbortController();
	parked;
	cancelled = false;
	startedAt = Date.now();
	constructor(engine, run, journal) {
		this.engine = engine;
		this.run = run;
		this.journal = journal;
	}
	get id() {
		return this.run.id;
	}
	get agent() {
		return this.run.agent;
	}
	get threadId() {
		return this.run.threadId;
	}
	get attempt() {
		return this.run.attempt;
	}
	get input() {
		return this.run.input;
	}
	get signal() {
		return this.controller.signal;
	}
	allocate(name) {
		const n = this.counters.get(name) ?? 0;
		this.counters.set(name, n + 1);
		return `${name}#${n}`;
	}
	isReplay(key) {
		return this.journal[key]?.kind === "step";
	}
	readStep(key) {
		const entry = this.journal[key];
		if (entry?.kind !== "step") return void 0;
		if (entry.error !== void 0) throw decode(entry.error);
		return {
			value: decode(entry.value),
			replayed: true
		};
	}
	async record(key, value) {
		this.journal[key] = {
			kind: "step",
			value: encode(value)
		};
		await this.persistJournal();
	}
	async persistJournal() {
		await this.engine.store.putJournal(this.run.id, this.journal);
	}
	/** Throws when the run may not start new live work: parked, cancelled or out of budget. */
	async assertLive() {
		if (this.parked) throw new RunHalted(this.parked.kind === "interrupt" ? "interrupt" : this.parked.kind);
		if (this.cancelled) throw new RunHalted("cancel");
		const now = Date.now();
		if (now - this.lastRemoteCheck > 1e3) {
			this.lastRemoteCheck = now;
			if ((await this.engine.store.getRun(this.run.id))?.status === "cancelled") this.cancel();
			if (this.cancelled) throw new RunHalted("cancel");
			await this.engine.store.renewLease(this.run.id, this.engine.owner, this.engine.leaseMs);
		}
		const budget = this.engine.options.budgetMs;
		if (budget !== void 0 && now - this.startedAt > budget) {
			this.park({ kind: "yield" });
			throw new RunHalted("yield");
		}
	}
	async durableCall(key, fn, options = {}) {
		const stepKey = typeof key === "string" ? key : this.allocate(key.name);
		const replayed = this.readStep(stepKey);
		if (replayed) return {
			value: replayed.value,
			replayed: true
		};
		await this.assertLive();
		let value;
		try {
			value = await fn();
		} catch (error) {
			if (error instanceof RunHalted || this.parked || this.cancelled) throw error;
			if (options.journalErrors !== false) {
				this.journal[stepKey] = {
					kind: "step",
					error: encode(error)
				};
				await this.persistJournal();
			}
			throw error;
		}
		await this.record(stepKey, value);
		return {
			value,
			replayed: false
		};
	}
	async step(name, fn, options = {}) {
		const key = this.allocate(name);
		const announce = options.announce !== false && !this.isReplay(key);
		if (announce) this.emitEvent({
			type: "STEP_STARTED",
			stepName: name
		});
		const { value } = await this.durableCall(key, fn);
		if (announce) this.emitEvent({
			type: "STEP_FINISHED",
			stepName: name
		});
		return value;
	}
	async interrupt(name, payload) {
		const key = this.allocate(`interrupt:${name}`);
		const entry = this.journal[key];
		if (entry?.kind === "interrupt" && entry.answered) return decode(entry.answer);
		this.park({
			kind: "interrupt",
			interrupt: {
				key,
				name,
				payload: toJsonSafe(payload)
			}
		});
		throw new RunHalted("interrupt");
	}
	async sleep(duration) {
		const ms = parseDuration(duration);
		const key = this.allocate("sleep");
		const entry = this.journal[key];
		if (entry?.kind === "sleep") {
			if (entry.woke || Date.now() >= entry.wakeAt) return;
			this.park({
				kind: "sleep",
				key,
				wakeAt: entry.wakeAt
			});
			throw new RunHalted("sleep");
		}
		await this.assertLive();
		const wakeAt = Date.now() + ms;
		this.journal[key] = {
			kind: "sleep",
			wakeAt
		};
		await this.persistJournal();
		if (ms === 0) return;
		this.park({
			kind: "sleep",
			key,
			wakeAt
		});
		throw new RunHalted("sleep");
	}
	state = {
		get: (key, options) => this.engine.store.getState(...this.scope(options?.scope), key),
		set: (key, value, options) => this.engine.store.setState(...this.scope(options?.scope), key, toJsonSafe(value)),
		delete: (key, options) => this.engine.store.deleteState(...this.scope(options?.scope), key)
	};
	scope(scope = "thread") {
		if (scope === "agent") return ["agent", this.run.agent];
		if (scope === "app") return ["app", "app"];
		return ["thread", this.run.threadId];
	}
	secrets = { get: (name) => this.engine.env()[name] };
	emit(name, value) {
		this.emitEvent({
			type: "CUSTOM",
			name,
			value: toJsonSafe(value)
		});
	}
	emitEvent(body) {
		const event = {
			...body,
			seq: ++this.run.eventCount,
			runId: this.run.id,
			timestamp: Date.now()
		};
		this.pending.push(event);
		this.engine.publish(event);
		this.flushing = this.flushing.then(async () => {
			const batch = this.pending.splice(0);
			if (batch.length) await this.engine.store.appendEvents(this.run.id, batch);
		});
	}
	flush() {
		return this.flushing;
	}
	park(parked) {
		if (this.parked || this.cancelled) return;
		this.parked = parked;
		this.controller.abort(new RunHalted(parked.kind === "interrupt" ? "interrupt" : parked.kind));
	}
	cancel() {
		if (this.cancelled) return;
		this.cancelled = true;
		this.controller.abort(new RunHalted("cancel"));
	}
};
/**
* Executes runs durably: journals every step, parks runs that interrupt or sleep, continues them
* later in any process, and never repeats completed work.
*/
var RunEngine = class {
	options;
	owner = randomId("worker", 10);
	leaseMs;
	agents = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Map();
	active = /* @__PURE__ */ new Map();
	timers = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
		for (const agent of options.agents) this.agents.set(agent.name, agent);
		this.leaseMs = options.leaseMs ?? 6e4;
	}
	get store() {
		return this.options.store;
	}
	env() {
		return this.options.env ?? globalThis.process?.env ?? {};
	}
	manifest() {
		return {
			version: 1,
			name: this.options.name ?? "agent-unit",
			agents: [...this.agents.values()].map((a) => a.card)
		};
	}
	agentCard(name) {
		const agent = this.agents.get(name);
		if (!agent) throw new AgentUnitError(404, "agent_not_found", `No agent named "${name}".`);
		return agent.card;
	}
	async getRun(id) {
		const run = await this.store.getRun(id);
		if (!run) throw new AgentUnitError(404, "run_not_found", `No run with id "${id}".`);
		return run;
	}
	listRuns(filter) {
		return this.store.listRuns(filter);
	}
	/** Creates a run and starts executing it. `done` settles when this execution stops. */
	async start(agentName, input = {}, options = {}) {
		this.agentCard(agentName);
		const id = randomId("run");
		const createdAt = nowIso();
		const run = {
			id,
			agent: agentName,
			threadId: options.threadId || id,
			status: "running",
			input: toJsonSafe(input),
			attempt: 0,
			eventCount: 1,
			createdAt,
			updatedAt: createdAt
		};
		const started = {
			type: "RUN_STARTED",
			threadId: run.threadId,
			agent: agentName,
			seq: 1,
			runId: id,
			timestamp: Date.now()
		};
		await this.store.putRun(run);
		await this.store.appendEvents(id, [started]);
		this.publish(started);
		return {
			run,
			done: this.schedule(id)
		};
	}
	/** Answers a parked interrupt and continues the run. */
	async resume(id, answer) {
		const run = await this.getRun(id);
		if (run.status !== "interrupted" || !run.interrupt) throw new AgentUnitError(409, "run_not_interrupted", `Run "${id}" is ${run.status}, not interrupted.`);
		const journal = await this.store.getJournal(id);
		journal[run.interrupt.key] = {
			kind: "interrupt",
			answered: true,
			answer: encode(answer)
		};
		await this.store.putJournal(id, journal);
		delete run.interrupt;
		run.status = "running";
		run.updatedAt = nowIso();
		await this.store.putRun(run);
		return {
			run,
			done: this.schedule(id)
		};
	}
	async cancel(id) {
		const run = await this.getRun(id);
		if (TERMINAL.has(run.status)) return run;
		const execution = this.active.get(id);
		if (execution) {
			execution.cancel();
			await this.idle(id);
			return this.getRun(id);
		}
		run.status = "cancelled";
		delete run.interrupt;
		delete run.wakeAt;
		const event = {
			type: "RUN_CANCELLED",
			seq: ++run.eventCount,
			runId: id,
			timestamp: Date.now()
		};
		run.updatedAt = nowIso();
		await this.store.putRun(run);
		await this.store.appendEvents(id, [event]);
		this.publish(event);
		this.clearTimer(id);
		return run;
	}
	/** Continues a running run whose execution stopped: after a yield, or a crash. */
	async continue(id) {
		const run = await this.store.getRun(id);
		if (!run || run.status !== "running" || this.active.has(id)) return run;
		if (!await this.store.leaseExpired(id)) return run;
		return this.schedule(id);
	}
	/**
	* Wakes due sleepers and recovers stalled runs. Run it on a schedule on serverless hosts.
	* `settled` resolves when the executions it started stop; pass it to the host's `waitUntil`.
	*/
	async sweep(now = Date.now()) {
		const woken = [];
		const recovered = [];
		const work = [];
		for (const run of await this.store.listRuns({
			status: "sleeping",
			limit: 1e3
		})) {
			if (!run.wakeAt || Date.parse(run.wakeAt) > now) continue;
			const execution = await this.wakeRun(run.id);
			if (execution) {
				woken.push(run.id);
				work.push(execution.done);
			}
		}
		for (const run of await this.store.listRuns({
			status: "running",
			limit: 1e3
		})) {
			if (this.active.has(run.id) || !await this.store.leaseExpired(run.id)) continue;
			recovered.push(run.id);
			work.push(this.schedule(run.id));
		}
		return {
			woken,
			recovered,
			settled: Promise.allSettled(work).then(() => void 0)
		};
	}
	async wake(id) {
		return await this.wakeRun(id) !== void 0;
	}
	async wakeRun(id) {
		const run = await this.store.getRun(id);
		if (!run || run.status !== "sleeping") return void 0;
		const journal = await this.store.getJournal(id);
		for (const entry of Object.values(journal)) if (entry.kind === "sleep" && !entry.woke) entry.woke = true;
		await this.store.putJournal(id, journal);
		run.status = "running";
		delete run.wakeAt;
		run.updatedAt = nowIso();
		await this.store.putRun(run);
		return { done: this.schedule(id) };
	}
	/** Events from `after`, then live ones, until the run settles. */
	async *events(id, after = 0, signal) {
		await this.getRun(id);
		let cursor = after;
		const queue = [];
		let wake;
		const listener = (event) => {
			queue.push(event);
			wake?.();
		};
		this.subscribe(id, listener);
		const onAbort = () => wake?.();
		signal?.addEventListener("abort", onAbort);
		const settled = async (event) => {
			if (!SETTLING_EVENTS.has(event.type) || this.active.has(id)) return false;
			const run = await this.store.getRun(id);
			return !run || run.status !== "running" && run.eventCount <= event.seq;
		};
		try {
			for (const event of await this.store.readEvents(id, cursor)) {
				cursor = event.seq;
				yield event;
				if (await settled(event)) return;
			}
			while (!signal?.aborted) {
				while (queue.length) {
					const event = queue.shift();
					if (event.seq <= cursor) continue;
					cursor = event.seq;
					yield event;
					if (SETTLING_EVENTS.has(event.type) && await settled(event)) return;
				}
				if (!this.active.has(id)) {
					for (const event of await this.store.readEvents(id, cursor)) {
						cursor = event.seq;
						yield event;
						if (await settled(event)) return;
					}
					const run = await this.store.getRun(id);
					if (!run || run.status !== "running" && !this.active.has(id) && run.eventCount <= cursor) return;
				}
				await new Promise((resolve) => {
					wake = resolve;
					setTimeout(resolve, this.options.pollMs ?? 250);
				});
				wake = void 0;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.unsubscribe(id, listener);
		}
	}
	/** Resolves when no execution of this run is active in this process. */
	async idle(id) {
		while (this.active.has(id)) await new Promise((resolve) => setTimeout(resolve, 5));
	}
	publish(event) {
		for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
	}
	subscribe(id, listener) {
		let set = this.listeners.get(id);
		if (!set) this.listeners.set(id, set = /* @__PURE__ */ new Set());
		set.add(listener);
	}
	unsubscribe(id, listener) {
		const set = this.listeners.get(id);
		set?.delete(listener);
		if (set?.size === 0) this.listeners.delete(id);
	}
	schedule(id) {
		const promise = this.execute(id);
		this.options.waitUntil?.(promise);
		return promise;
	}
	clearTimer(id) {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
	}
	async execute(id) {
		const run = await this.store.getRun(id);
		if (!run || run.status !== "running" || this.active.has(id)) return run;
		const loaded = this.agents.get(run.agent);
		if (!loaded) return run;
		if (!await this.store.acquireLease(id, this.owner, this.leaseMs)) return run;
		run.attempt += 1;
		run.updatedAt = nowIso();
		await this.store.putRun(run);
		const execution = new RunExecution(this, run, await this.store.getJournal(id));
		this.active.set(id, execution);
		let yielded = false;
		try {
			const durable = createDurable();
			let output;
			let failure;
			try {
				output = await runWithContext(execution, () => settle(loaded.adapter.run(loaded.agent, {
					input: execution.input,
					signal: execution.signal,
					run: execution,
					durable
				})));
			} catch (error) {
				failure = error;
			}
			if (execution.cancelled) {
				run.status = "cancelled";
				execution.emitEvent({ type: "RUN_CANCELLED" });
			} else if (execution.parked?.kind === "interrupt") {
				run.status = "interrupted";
				run.interrupt = execution.parked.interrupt;
				execution.emitEvent({
					type: "RUN_INTERRUPTED",
					interrupt: execution.parked.interrupt
				});
			} else if (execution.parked?.kind === "sleep") {
				run.status = "sleeping";
				run.wakeAt = new Date(execution.parked.wakeAt).toISOString();
				execution.emitEvent({
					type: "RUN_SLEEPING",
					wakeAt: run.wakeAt
				});
				this.armTimer(id, execution.parked.wakeAt);
			} else if (execution.parked?.kind === "yield") yielded = true;
			else if (failure !== void 0) {
				run.status = "failed";
				run.error = errorInfo(failure);
				execution.emitEvent({
					type: "RUN_ERROR",
					message: run.error.message,
					code: run.error.name
				});
			} else {
				run.status = "completed";
				run.output = toJsonSafe(output);
				execution.emitEvent({
					type: "RUN_FINISHED",
					result: run.output
				});
			}
			await execution.flush();
			run.updatedAt = nowIso();
			await this.store.putRun(run);
		} finally {
			this.active.delete(id);
			await this.store.releaseLease(id, this.owner);
		}
		if (yielded) {
			if (this.options.continueRun) await this.options.continueRun(id);
			else return this.schedule(id);
		}
		return run;
	}
	armTimer(id, wakeAt) {
		const delay = wakeAt - Date.now();
		if (delay > MAX_LOCAL_SLEEP_MS) return;
		this.clearTimer(id);
		const timer = setTimeout(() => {
			this.timers.delete(id);
			this.wake(id);
		}, Math.max(0, delay));
		timer.unref?.();
		this.timers.set(id, timer);
	}
	/** Stops timers. Call when the process shuts down. */
	close() {
		for (const id of [...this.timers.keys()]) this.clearTimer(id);
	}
};
const pad = (seq) => String(seq).padStart(10, "0");
/**
* Persists runs, journals, events, state and leases on any unstorage driver: memory, the
* filesystem, Redis, Cloudflare KV, Vercel KV, Netlify Blobs, Deno KV, a database, …
*/
var RunStore = class {
	storage;
	constructor(storage) {
		this.storage = storage;
	}
	async getRun(id) {
		return await this.storage.getItem(`runs:${id}`) ?? void 0;
	}
	async putRun(run) {
		await this.storage.setItem(`runs:${run.id}`, run);
	}
	async listRuns(filter = {}) {
		const keys = await this.storage.getKeys("runs");
		const runs = [];
		for (const key of keys) {
			const run = await this.storage.getItem(key);
			if (!run) continue;
			if (filter.agent && run.agent !== filter.agent) continue;
			if (filter.status && run.status !== filter.status) continue;
			if (filter.threadId && run.threadId !== filter.threadId) continue;
			runs.push(run);
		}
		runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return runs.slice(0, filter.limit ?? 50);
	}
	async getJournal(id) {
		return await this.storage.getItem(`journal:${id}`) ?? {};
	}
	async putJournal(id, journal) {
		await this.storage.setItem(`journal:${id}`, journal);
	}
	async appendEvents(id, events) {
		for (const event of events) await this.storage.setItem(`events:${id}:${pad(event.seq)}`, event);
	}
	async readEvents(id, after = 0) {
		const keys = (await this.storage.getKeys(`events:${id}`)).sort();
		const events = [];
		for (const key of keys) {
			if (Number(key.slice(key.lastIndexOf(":") + 1)) <= after) continue;
			const event = await this.storage.getItem(key);
			if (event) events.push(event);
		}
		return events;
	}
	stateKey(scope, owner, key) {
		return `state:${scope}:${owner}:${key}`;
	}
	async getState(scope, owner, key) {
		return await this.storage.getItem(this.stateKey(scope, owner, key)) ?? void 0;
	}
	async setState(scope, owner, key, value) {
		await this.storage.setItem(this.stateKey(scope, owner, key), value);
	}
	async deleteState(scope, owner, key) {
		await this.storage.removeItem(this.stateKey(scope, owner, key));
	}
	/**
	* Takes the run's execution lease. Only one process executes a run at a time: a duplicate resume,
	* a continuation and the sweep can race, and the loser backs off.
	*/
	async acquireLease(id, owner, ttlMs) {
		const key = `lease:${id}`;
		const current = await this.storage.getItem(key);
		if (current && current.owner !== owner && current.until > Date.now()) return false;
		await this.storage.setItem(key, {
			owner,
			until: Date.now() + ttlMs
		});
		return (await this.storage.getItem(key))?.owner === owner;
	}
	async renewLease(id, owner, ttlMs) {
		await this.storage.setItem(`lease:${id}`, {
			owner,
			until: Date.now() + ttlMs
		});
	}
	async releaseLease(id, owner) {
		const key = `lease:${id}`;
		if ((await this.storage.getItem(key))?.owner === owner) await this.storage.removeItem(key);
	}
	async leaseExpired(id) {
		const current = await this.storage.getItem(`lease:${id}`);
		return !current || current.until <= Date.now();
	}
};
//#endregion
//#region ../../../../dist/app.mjs
/** An A2A agent card for the app: one skill per agent (spec/manifest.md). */
function agentCardDocument(manifest, url, version = "0.0.0") {
	return {
		protocolVersion: "0.3.0",
		name: manifest.name,
		description: `Agents served by ${manifest.name} with agent-unit.`,
		url,
		version,
		preferredTransport: "JSONRPC",
		capabilities: {
			streaming: true,
			pushNotifications: false,
			stateTransitionHistory: true
		},
		defaultInputModes: ["text/plain", "application/json"],
		defaultOutputModes: ["text/plain", "application/json"],
		skills: manifest.agents.map((agent) => ({
			id: agent.name,
			name: agent.name,
			description: agent.description ?? `A ${agent.framework} agent.`,
			tags: [agent.framework, ...agent.tools.map((tool) => tool.name)]
		}))
	};
}
const SUPPORTED_VERSIONS = [
	"2025-06-18",
	"2025-03-26",
	"2024-11-05"
];
const rpcResult = (id, result) => ({
	jsonrpc: "2.0",
	id: id ?? null,
	result
});
const rpcError = (id, code, message) => ({
	jsonrpc: "2.0",
	id: id ?? null,
	error: {
		code,
		message
	}
});
function toolList(engine) {
	return engine.manifest().agents.map((agent) => ({
		name: agent.name,
		description: agent.description ?? `Run the ${agent.name} agent (${agent.framework}).`,
		inputSchema: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "What to ask the agent."
				},
				threadId: {
					type: "string",
					description: "Continue an earlier conversation."
				}
			},
			required: ["message"]
		}
	}));
}
async function callTool(engine, params, context) {
	const name = String(params.name ?? "");
	const args = params.arguments ?? {};
	if (typeof args.message !== "string") return {
		content: [{
			type: "text",
			text: "`message` must be a string."
		}],
		isError: true
	};
	const { run, done } = await engine.start(name, { messages: [{
		role: "user",
		content: args.message
	}] }, { threadId: typeof args.threadId === "string" ? args.threadId : void 0 });
	context.waitUntil?.(done);
	const final = await done ?? await engine.getRun(run.id);
	if (final.status === "completed") return {
		content: [{
			type: "text",
			text: typeof final.output === "string" ? final.output : JSON.stringify(final.output)
		}],
		structuredContent: {
			status: final.status,
			runId: final.id,
			output: final.output
		}
	};
	if (final.status === "failed") return {
		content: [{
			type: "text",
			text: final.error?.message ?? "The run failed."
		}],
		isError: true
	};
	const parked = {
		status: final.status,
		runId: final.id,
		interrupt: final.interrupt,
		wakeAt: final.wakeAt
	};
	return {
		content: [{
			type: "text",
			text: final.status === "interrupted" ? `The run is waiting for input (${final.interrupt?.name}). Resume it with POST /runs/${final.id}/resume.` : `The run is ${final.status}. Follow it at /runs/${final.id}/events.`
		}],
		structuredContent: parked
	};
}
async function respond(engine, message, context, version) {
	switch (message.method) {
		case "initialize": {
			const requested = String(message.params?.protocolVersion ?? "");
			return rpcResult(message.id, {
				protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: {
					name: engine.manifest().name,
					version
				}
			});
		}
		case "ping": return rpcResult(message.id, {});
		case "tools/list": return rpcResult(message.id, { tools: toolList(engine) });
		case "tools/call": try {
			return rpcResult(message.id, await callTool(engine, message.params ?? {}, context));
		} catch (error) {
			return rpcError(message.id, -32602, error instanceof Error ? error.message : String(error));
		}
		default: return rpcError(message.id, -32601, `Method not found: ${message.method}`);
	}
}
async function handleMcp(engine, request, context, version = "0.0.0") {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
	}
	const messages = Array.isArray(payload) ? payload : [payload];
	const responses = [];
	for (const message of messages) {
		if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
			responses.push(rpcError(message?.id, -32600, "Invalid request"));
			continue;
		}
		if (message.id === void 0) continue;
		responses.push(await respond(engine, message, context, version));
	}
	if (responses.length === 0) return new Response(null, { status: 202 });
	return Response.json(Array.isArray(payload) ? responses : responses[0], { headers: { "cache-control": "no-store" } });
}
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), {
	status,
	headers: {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers
	}
});
const problem = (status, code, message) => json({ error: {
	code,
	message
} }, status);
const wantsStream = (request) => (request.headers.get("accept") ?? "").includes("text/event-stream");
async function readJson(request) {
	const text = await request.text();
	if (!text.trim()) return {};
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new AgentUnitError(400, "invalid_json", "The request body is not valid JSON.");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentUnitError(400, "invalid_body", "The request body must be a JSON object.");
	return body;
}
/** Streams events as SSE: `id:` is the event's seq so a reconnecting client resumes exactly. */
function eventStream(events, signal, heartbeatMs = 15e3) {
	const encoder = new TextEncoder();
	let heartbeat;
	const body = new ReadableStream({
		async start(controller) {
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					clearInterval(heartbeat);
				}
			}, heartbeatMs);
			try {
				for await (const event of events) {
					if (signal.aborted) break;
					controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
			} finally {
				clearInterval(heartbeat);
				controller.close();
			}
		},
		cancel() {
			clearInterval(heartbeat);
		}
	});
	return new Response(body, { headers: {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no"
	} });
}
const RUN_STATUSES = /* @__PURE__ */ new Set([
	"running",
	"interrupted",
	"sleeping",
	"completed",
	"failed",
	"cancelled"
]);
/**
* The agent-unit HTTP API (spec/runs.md) as a Web `Request → Response` handler. Mount it in Nitro,
* Bun.serve, Deno.serve, a Worker, Hono, or any Fetch-based server.
*/
function createHandler(engine, options = {}) {
	const base = (options.basePath ?? "").replace(/\/+$/, "");
	const secret = () => options.secret ?? engine.env().AGENT_UNIT_SECRET;
	let origin;
	if (!engine.options.continueRun) engine.options.continueRun = async (id) => {
		const token = secret();
		if (!origin || !token) {
			await engine.continue(id);
			return;
		}
		if (!(await fetch(`${origin}${base}/__agent-unit/continue/${encodeURIComponent(id)}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` }
		}).catch(() => void 0))?.ok) await engine.continue(id);
	};
	const internalAllowed = (request) => {
		const token = secret();
		return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
	};
	return async function handle(request, context = {}) {
		const url = new URL(request.url);
		origin ??= url.origin;
		if (base && !url.pathname.startsWith(base)) return problem(404, "not_found", "Not found.");
		const path = url.pathname.slice(base.length).replace(/\/+$/, "") || "/";
		const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
		const method = request.method.toUpperCase();
		try {
			if (method === "GET" && path === "/.well-known/agent.json") return json(agentCardDocument(engine.manifest(), `${url.origin}${base}`, options.version));
			if (segments[0] === "__agent-unit") {
				if (!internalAllowed(request)) return problem(401, "unauthorized", "Missing or invalid agent-unit secret.");
				if (method === "POST" && segments[1] === "continue" && segments[2]) {
					const done = engine.continue(segments[2]);
					context.waitUntil?.(done);
					return json({ ok: true }, 202);
				}
				if (segments[1] === "sweep") {
					const { woken, recovered, settled } = await engine.sweep();
					context.waitUntil?.(settled);
					return json({
						woken,
						recovered
					});
				}
				return problem(404, "not_found", "Not found.");
			}
			if (options.authorize) {
				const verdict = await options.authorize(request);
				if (verdict instanceof Response) return verdict;
				if (!verdict) return problem(401, "unauthorized", "Unauthorized.");
			}
			if (method === "GET" && (path === "/" || path === "/manifest.json")) return json(engine.manifest());
			if (method === "POST" && path === "/mcp") return await handleMcp(engine, request, context, options.version);
			if (method === "GET" && path === "/mcp") return problem(405, "method_not_allowed", "Use POST for MCP requests.");
			if (segments[0] === "agents") {
				if (method === "GET" && segments.length === 1) return json({ agents: engine.manifest().agents });
				const agent = segments[1];
				if (agent && method === "GET" && segments.length === 2) return json(engine.agentCard(agent));
				if (agent && method === "POST" && segments[2] === "runs" && segments.length === 3) {
					const body = await readJson(request);
					const input = body.input ?? {};
					if (typeof input !== "object" || input === null || Array.isArray(input)) throw new AgentUnitError(400, "invalid_input", "`input` must be an object.");
					const threadId = typeof body.threadId === "string" ? body.threadId : void 0;
					const { run, done } = await engine.start(agent, input, { threadId });
					context.waitUntil?.(done);
					if (wantsStream(request)) return eventStream(engine.events(run.id, 0, request.signal), request.signal, options.heartbeatMs);
					return json(run, 202);
				}
			}
			if (segments[0] === "runs") {
				const id = segments[1];
				if (!id && method === "GET") {
					const status = url.searchParams.get("status");
					if (status && !RUN_STATUSES.has(status)) throw new AgentUnitError(400, "invalid_status", `Unknown status "${status}".`);
					const limit = Number(url.searchParams.get("limit") ?? 50);
					const runs = await engine.listRuns({
						agent: url.searchParams.get("agent") ?? void 0,
						status: status ?? void 0,
						threadId: url.searchParams.get("threadId") ?? void 0,
						limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50
					});
					return json({ runs });
				}
				if (id && method === "GET" && segments.length === 2) return json(await engine.getRun(id));
				if (id && method === "GET" && segments[2] === "events") {
					const after = Number(url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? 0);
					return eventStream(engine.events(id, Number.isFinite(after) ? after : 0, request.signal), request.signal, options.heartbeatMs);
				}
				if (id && method === "POST" && segments[2] === "resume") {
					const body = await readJson(request);
					const before = (await engine.getRun(id)).eventCount;
					const { run, done } = await engine.resume(id, body.answer);
					context.waitUntil?.(done);
					if (wantsStream(request)) return eventStream(engine.events(id, before, request.signal), request.signal, options.heartbeatMs);
					return json(run, 202);
				}
				if (id && method === "POST" && segments[2] === "cancel") return json(await engine.cancel(id));
			}
			return problem(404, "not_found", `No route for ${method} ${path}.`);
		} catch (error) {
			if (error instanceof AgentUnitError) return problem(error.status, error.code, error.message);
			console.error("[agent-unit]", error);
			return problem(500, "internal_error", "Internal error.");
		}
	};
}
const ms = (value) => value === void 0 || value === false ? void 0 : typeof value === "number" ? value : parseDuration(value);
/** Builds a durable agent server from agents and storage. Mount `handler` anywhere that speaks Fetch. */
function createAgentUnit(options) {
	const adapters = [...options.adapters ?? [], functionAdapter];
	const agents = Object.entries(options.agents).map(([name, agent]) => resolveAgent(name, agent, adapters));
	const engine = new RunEngine({
		store: options.storage instanceof RunStore ? options.storage : new RunStore(options.storage),
		agents,
		name: options.name,
		budgetMs: ms(options.budget),
		leaseMs: ms(options.lease),
		env: options.env,
		waitUntil: options.waitUntil
	});
	const handler = createHandler(engine, options);
	return {
		engine,
		handler,
		fetch: (request) => handler(request),
		close: () => engine.close()
	};
}
//#endregion
//#region #nitro/virtual/server-assets
const _assets = {};
const normalizeKey = function normalizeKey(key) {
	if (!key) return "";
	return key.split("?")[0]?.replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "") || "";
};
const assets = {
	getKeys() {
		return Promise.resolve(Object.keys(_assets));
	},
	hasItem(id) {
		id = normalizeKey(id);
		return Promise.resolve(id in _assets);
	},
	getItem(id) {
		id = normalizeKey(id);
		return Promise.resolve(_assets[id] ? _assets[id].import() : null);
	},
	getMeta(id) {
		id = normalizeKey(id);
		return Promise.resolve(_assets[id] ? _assets[id].meta : {});
	}
};
//#endregion
//#region #nitro/virtual/storage
function initStorage() {
	const storage = createStorage({});
	storage.mount("/assets", assets);
	storage.mount("agent-unit", driver({ "base": ".data/agent-unit" }));
	return storage;
}
//#endregion
//#region ../../../../node_modules/.pnpm/nitro@3.0.260903-beta/node_modules/nitro/dist/runtime/internal/storage.mjs
function useStorage(base = "") {
	const storage = useStorage._storage ??= initStorage();
	return base ? prefixStorage(storage, base) : storage;
}
//#endregion
//#region ../../../../dist/adapters/ai-sdk.mjs
function isToolLoopAgent(value) {
	return typeof value === "object" && value !== null && value.version === "agent-v1" && typeof value.stream === "function";
}
function isPlainConfig(value) {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype && "model" in value;
}
function callInput(input) {
	if (Array.isArray(input.messages)) return { messages: input.messages };
	if (typeof input.prompt === "string") return { prompt: input.prompt };
	if (typeof input.message === "string") return { prompt: input.message };
	return { prompt: "" };
}
function toolCards(tools) {
	return Object.entries(tools ?? {}).map(([name, tool]) => {
		const description = tool?.description;
		return typeof description === "string" ? {
			name,
			description
		} : { name };
	});
}
const durableAgents = /* @__PURE__ */ new WeakMap();
function durableToolLoopAgent(agent, durable) {
	let copy = durableAgents.get(agent);
	if (copy) return copy;
	const settings = agent.settings;
	if (!settings) return agent;
	const Ctor = agent.constructor;
	copy = new Ctor({
		...settings,
		model: durable.model(settings.model),
		tools: durable.tools(settings.tools ?? {})
	});
	durableAgents.set(agent, copy);
	return copy;
}
/**
* The Vercel AI SDK: `ToolLoopAgent` instances and plain `streamText` settings objects. Model calls
* and tool calls become durable steps. (A model given as a gateway string id cannot be wrapped, so
* its calls repeat on replay; pass a provider model to make them durable too.)
*/
const aiSdkAdapter = defineAdapter({
	name: "ai-sdk",
	match: (value) => isToolLoopAgent(value) || isPlainConfig(value),
	describe(agent) {
		if (isToolLoopAgent(agent)) return { tools: toolCards(agent.tools ?? agent.settings?.tools) };
		return {
			description: agent.description,
			tools: toolCards(agent.tools)
		};
	},
	async run(agent, { input, signal, durable }) {
		if (isToolLoopAgent(agent)) return await (await durableToolLoopAgent(agent, durable).stream({
			...callInput(input),
			abortSignal: signal
		})).text;
		const { streamText } = await import("../_libs/ai.mjs").then((n) => n.dist_exports);
		const { description: _description, ...settings } = agent;
		return await streamText({
			...settings,
			model: durable.model(agent.model),
			tools: durable.tools(agent.tools ?? {}),
			...callInput(input),
			abortSignal: signal
		}).text;
	}
});
//#endregion
//#region ../../../../dist/index.mjs
/** Types an `agent-unit.config.ts`. */
function defineConfig(config) {
	return config;
}
//#endregion
//#region agent-unit.config.ts
var agent_unit_config_default = defineConfig({
	name: "basic",
	storage: {
		driver: "fs-lite",
		base: process.env.AGENT_UNIT_DATA ?? ".data/agent-unit"
	},
	authorize: (request) => {
		const token = process.env.API_TOKEN;
		return !token || request.headers.get("authorization") === `Bearer ${token}`;
	}
});
//#endregion
//#region agents/greeter.ts
var greeter_exports = /* @__PURE__ */ __exportAll({ default: () => greeter_default });
var greeter_default = defineAgent(async (input, run) => {
	const name = (input.messages ?? []).at(-1)?.content ?? String(input.name ?? "world");
	return `${run.secrets.get("GREETING") ?? "hello"} ${name}`;
});
//#endregion
//#region agents/napper.ts
var napper_exports = /* @__PURE__ */ __exportAll({ default: () => napper_default });
var napper_default = defineAgent(async (input, run) => {
	const before = await run.step("before", () => Date.now());
	await run.sleep(Number(input.ms ?? 300));
	return { slept: await run.step("after", () => Date.now()) - before >= Number(input.ms ?? 300) };
});
//#endregion
//#region agents/refund.ts
var refund_exports = /* @__PURE__ */ __exportAll({ default: () => refund_default });
async function countSideEffect(name) {
	const run = useRun();
	const count = (await run.state.get(name, { scope: "app" }) ?? 0) + 1;
	await run.state.set(name, count, { scope: "app" });
	return count;
}
var refund_default = defineAgent({
	description: "Refunds an order after a human approves it.",
	tools: [{
		name: "charge",
		description: "Refunds the card."
	}],
	async run(input, run) {
		const order = await run.step("load-order", () => countSideEffect("loads").then(() => ({
			id: String(input.orderId),
			amount: 42
		})));
		if (!(await run.interrupt("approve-refund", order)).approved) return {
			status: "declined",
			order: order.id
		};
		await run.step("charge", () => countSideEffect("charges"));
		return {
			status: "refunded",
			order: order.id,
			amount: order.amount
		};
	}
});
//#endregion
//#region .agent-unit/runtime.mjs
const env = new Proxy({}, { get: (_, key) => typeof key === "string" ? globalThis.__env__?.[key] ?? globalThis.process?.env?.[key] : void 0 });
const unit = createAgentUnit({
	name: agent_unit_config_default.name ?? "basic",
	agents: agent_unit_config_default.agents ?? {
		"greeter": greeter_exports,
		"napper": napper_exports,
		"refund": refund_exports
	},
	adapters: [...agent_unit_config_default.adapters ?? [], aiSdkAdapter],
	storage: useStorage("agent-unit"),
	budget: false,
	basePath: agent_unit_config_default.basePath,
	authorize: agent_unit_config_default.authorize,
	env
});
//#endregion
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
function startScheduleRunner({ waitUntil } = {}) {
	if (!scheduledTasks || scheduledTasks.length === 0 || process.env.TEST) return;
	const payload = { scheduledTime: Date.now() };
	for (const schedule of scheduledTasks) new E(schedule.cron, async () => {
		await Promise.all(schedule.tasks.map((name) => runTask(name, {
			payload,
			context: { waitUntil }
		}).catch((error) => {
			console.error(`Error while running scheduled task "${name}"`, error);
		})));
	});
}
//#endregion
export { defineTask, startScheduleRunner, unit };
