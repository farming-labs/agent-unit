import { existsSync, promises } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/_chunks/libs/destr.mjs
const suspectProtoRx = /"(?:_|\\u0{2}5[Ff]){2}(?:p|\\u0{2}70)(?:r|\\u0{2}72)(?:o|\\u0{2}6[Ff])(?:t|\\u0{2}74)(?:o|\\u0{2}6[Ff])(?:_|\\u0{2}5[Ff]){2}"\s*:/;
const suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
const JsonSigRx = /^\s*["[{]|^\s*-?\d{1,16}(\.\d{1,17})?([Ee][+-]?\d+)?\s*$/;
function jsonParseTransform(key, value) {
	if (key === "__proto__" || key === "constructor" && value && typeof value === "object" && "prototype" in value) {
		warnKeyDropped(key);
		return;
	}
	return value;
}
function warnKeyDropped(key) {
	console.warn(`[destr] Dropping "${key}" key to prevent prototype pollution.`);
}
function destr(value, options = {}) {
	if (typeof value !== "string") return value;
	if (value[0] === "\"" && value[value.length - 1] === "\"" && value.indexOf("\\") === -1) return value.slice(1, -1);
	const _value = value.trim();
	if (_value.length <= 9) switch (_value.toLowerCase()) {
		case "true": return true;
		case "false": return false;
		case "undefined": return;
		case "null": return null;
		case "nan": return NaN;
		case "infinity": return Number.POSITIVE_INFINITY;
		case "-infinity": return Number.NEGATIVE_INFINITY;
	}
	if (!JsonSigRx.test(value)) {
		if (options.strict) throw new SyntaxError("[destr] Invalid JSON");
		return value;
	}
	try {
		if (suspectProtoRx.test(value) || suspectConstructorRx.test(value)) {
			if (options.strict) throw new Error("[destr] Possible prototype pollution");
			return JSON.parse(value, jsonParseTransform);
		}
		return JSON.parse(value);
	} catch (error) {
		if (options.strict) throw error;
		return value;
	}
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/_chunks/utils.mjs
function createError(driver, message, opts) {
	const err = new Error(`[unstorage] [${driver}] ${message}`, opts);
	if (Error.captureStackTrace) Error.captureStackTrace(err, createError);
	return err;
}
function createRequiredError(driver, name) {
	if (Array.isArray(name)) return createError(driver, `Missing some of the required options ${name.map((n) => "`" + n + "`").join(", ")}`);
	return createError(driver, `Missing required option \`${name}\`.`);
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/drivers/memory.mjs
const DRIVER_NAME$1 = "memory";
const driver$1 = () => {
	const data = /* @__PURE__ */ new Map();
	const timers = /* @__PURE__ */ new Map();
	return {
		name: DRIVER_NAME$1,
		getInstance: () => data,
		hasItem(key) {
			return data.has(key);
		},
		getItem(key) {
			return data.get(key) ?? null;
		},
		getItemRaw(key) {
			return data.get(key) ?? null;
		},
		setItem(key, value, opts) {
			_clearTimer(timers, key);
			data.set(key, value);
			_scheduleExpiry(data, timers, key, opts?.ttl);
		},
		setItemRaw(key, value, opts) {
			_clearTimer(timers, key);
			data.set(key, value);
			_scheduleExpiry(data, timers, key, opts?.ttl);
		},
		removeItem(key) {
			_clearTimer(timers, key);
			data.delete(key);
		},
		getKeys() {
			return [...data.keys()];
		},
		clear() {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			data.clear();
		},
		dispose() {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			data.clear();
		}
	};
};
function _clearTimer(timers, key) {
	const existing = timers.get(key);
	if (existing !== void 0) {
		clearTimeout(existing);
		timers.delete(key);
	}
}
function _scheduleExpiry(data, timers, key, ttl) {
	if (!ttl) return;
	const ttlMs = ttl * 1e3;
	const timer = setTimeout(() => {
		data.delete(key);
		timers.delete(key);
	}, ttlMs);
	if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
	timers.set(key, timer);
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/_chunks/_utils.mjs
function wrapToPromise(value) {
	if (!value || typeof value.then !== "function") return Promise.resolve(value);
	return value;
}
function asyncCall(function_, ...arguments_) {
	try {
		return wrapToPromise(function_(...arguments_));
	} catch (error) {
		return Promise.reject(error);
	}
}
function isPrimitive(value) {
	const type = typeof value;
	return value === null || type !== "object" && type !== "function";
}
function isPureObject(value) {
	const proto = Object.getPrototypeOf(value);
	return !proto || proto.isPrototypeOf(Object);
}
function stringify(value) {
	if (isPrimitive(value)) return String(value);
	if (isPureObject(value) || Array.isArray(value)) return JSON.stringify(value);
	if (typeof value.toJSON === "function") return stringify(value.toJSON());
	throw new Error("[unstorage] Cannot stringify value!");
}
const BASE64_PREFIX = "base64:";
function serializeRaw(value) {
	if (typeof value === "string") return value;
	return BASE64_PREFIX + base64Encode(value);
}
function deserializeRaw(value) {
	if (typeof value !== "string") return value;
	if (!value.startsWith("base64:")) return value;
	return base64Decode(value.slice(7));
}
function base64Decode(input) {
	if (typeof Buffer !== "undefined") return Buffer.from(input, "base64");
	return Uint8Array.from(globalThis.atob(input), (c) => c.codePointAt(0));
}
function base64Encode(input) {
	if (typeof Buffer !== "undefined") return Buffer.from(input).toString("base64");
	return globalThis.btoa(String.fromCodePoint(...input));
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/_chunks/utils2.mjs
const storageKeyProperties = [
	"has",
	"hasItem",
	"get",
	"getItem",
	"getItemRaw",
	"set",
	"setItem",
	"setItemRaw",
	"del",
	"remove",
	"removeItem",
	"getMeta",
	"setMeta",
	"removeMeta",
	"clear",
	"mount",
	"unmount"
];
function prefixStorage(storage, base) {
	base = normalizeBaseKey(base);
	if (!base) return storage;
	const nsStorage = { ...storage };
	for (const property of storageKeyProperties) nsStorage[property] = (key = "", ...args) => storage[property](base + key, ...args);
	nsStorage.getKeys = (key = "", ...arguments_) => storage.getKeys(base + key, ...arguments_).then((keys) => keys.map((key) => key.slice(base.length)));
	nsStorage.keys = nsStorage.getKeys;
	nsStorage.watch = (callback) => storage.watch((event, key) => {
		if (key.startsWith(base)) return callback(event, key.slice(base.length));
	});
	nsStorage.getItems = async (items, commonOptions) => {
		const prefixedItems = items.map((item) => typeof item === "string" ? base + item : {
			...item,
			key: base + item.key
		});
		return (await storage.getItems(prefixedItems, commonOptions)).map((entry) => ({
			key: entry.key.slice(base.length),
			value: entry.value
		}));
	};
	nsStorage.setItems = async (items, commonOptions) => {
		const prefixedItems = items.map((item) => ({
			key: base + item.key,
			value: item.value,
			options: item.options
		}));
		return storage.setItems(prefixedItems, commonOptions);
	};
	return nsStorage;
}
function normalizeKey(key) {
	if (!key) return "";
	return key.split("?")[0]?.replace(/[/\\]/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "") || "";
}
function joinKeys(...keys) {
	return normalizeKey(keys.join(":"));
}
function normalizeBaseKey(base) {
	base = normalizeKey(base);
	return base ? base + ":" : "";
}
function filterKeyByDepth(key, depth) {
	if (depth === void 0) return true;
	let substrCount = 0;
	let index = key.indexOf(":");
	while (index > -1) {
		substrCount++;
		index = key.indexOf(":", index + 1);
	}
	return substrCount <= depth;
}
function filterKeyByBase(key, base) {
	if (base) return key.startsWith(base) && key[key.length - 1] !== "$";
	return key[key.length - 1] !== "$";
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/index.mjs
function createStorage(options = {}) {
	const context = {
		mounts: { "": options.driver || driver$1() },
		mountpoints: [""],
		watching: false,
		watchListeners: [],
		unwatch: {}
	};
	const getMount = (key) => {
		for (const base of context.mountpoints) if (key.startsWith(base)) return {
			base,
			relativeKey: key.slice(base.length),
			driver: context.mounts[base]
		};
		return {
			base: "",
			relativeKey: key,
			driver: context.mounts[""]
		};
	};
	const getMounts = (base, includeParent) => {
		return context.mountpoints.filter((mountpoint) => mountpoint.startsWith(base) || includeParent && base.startsWith(mountpoint)).map((mountpoint) => ({
			relativeBase: base.length > mountpoint.length ? base.slice(mountpoint.length) : void 0,
			mountpoint,
			driver: context.mounts[mountpoint]
		}));
	};
	const onChange = (event, key) => {
		if (!context.watching) return;
		key = normalizeKey(key);
		for (const listener of context.watchListeners) listener(event, key);
	};
	const startWatch = async () => {
		if (context.watching) return;
		context.watching = true;
		for (const mountpoint in context.mounts) context.unwatch[mountpoint] = await watch(context.mounts[mountpoint], onChange, mountpoint);
	};
	const stopWatch = async () => {
		if (!context.watching) return;
		for (const mountpoint in context.unwatch) await context.unwatch[mountpoint]();
		context.unwatch = {};
		context.watching = false;
	};
	const runBatch = (items, commonOptions, cb) => {
		const batches = /* @__PURE__ */ new Map();
		const getBatch = (mount) => {
			let batch = batches.get(mount.base);
			if (!batch) {
				batch = {
					driver: mount.driver,
					base: mount.base,
					items: []
				};
				batches.set(mount.base, batch);
			}
			return batch;
		};
		for (const item of items) {
			const isStringItem = typeof item === "string";
			const key = normalizeKey(isStringItem ? item : item.key);
			const value = isStringItem ? void 0 : item.value;
			const options = isStringItem || !item.options ? commonOptions : {
				...commonOptions,
				...item.options
			};
			const mount = getMount(key);
			getBatch(mount).items.push({
				key,
				value,
				relativeKey: mount.relativeKey,
				options
			});
		}
		return Promise.all([...batches.values()].map((batch) => cb(batch))).then((r) => r.flat());
	};
	const storage = {
		hasItem(key, opts = {}) {
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			return asyncCall(driver.hasItem, relativeKey, opts);
		},
		getItem(key, opts = {}) {
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			return asyncCall(driver.getItem, relativeKey, opts).then((value) => destr(value));
		},
		getItems(items, commonOptions = {}) {
			return runBatch(items, commonOptions, (batch) => {
				if (batch.driver.getItems) return asyncCall(batch.driver.getItems, batch.items.map((item) => ({
					key: item.relativeKey,
					options: item.options
				})), commonOptions).then((r) => r.map((item) => ({
					key: joinKeys(batch.base, item.key),
					value: destr(item.value)
				})));
				return Promise.all(batch.items.map((item) => {
					return asyncCall(batch.driver.getItem, item.relativeKey, item.options).then((value) => ({
						key: item.key,
						value: destr(value)
					}));
				}));
			});
		},
		getItemRaw(key, opts = {}) {
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			if (driver.getItemRaw) return asyncCall(driver.getItemRaw, relativeKey, opts);
			return asyncCall(driver.getItem, relativeKey, opts).then((value) => deserializeRaw(value));
		},
		async setItem(key, value, opts = {}) {
			if (value === void 0) return storage.removeItem(key);
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			if (!driver.setItem) return;
			await asyncCall(driver.setItem, relativeKey, stringify(value), opts);
			if (!driver.watch) onChange("update", key);
		},
		async setItems(items, commonOptions) {
			await runBatch(items, commonOptions, async (batch) => {
				if (batch.driver.setItems) return asyncCall(batch.driver.setItems, batch.items.map((item) => ({
					key: item.relativeKey,
					value: stringify(item.value),
					options: item.options
				})), commonOptions);
				if (!batch.driver.setItem) return;
				await Promise.all(batch.items.map((item) => {
					return asyncCall(batch.driver.setItem, item.relativeKey, stringify(item.value), item.options);
				}));
			});
		},
		async setItemRaw(key, value, opts = {}) {
			if (value === void 0) return storage.removeItem(key, opts);
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			if (driver.setItemRaw) await asyncCall(driver.setItemRaw, relativeKey, value, opts);
			else if (driver.setItem) await asyncCall(driver.setItem, relativeKey, serializeRaw(value), opts);
			else return;
			if (!driver.watch) onChange("update", key);
		},
		async removeItem(key, opts = {}) {
			if (typeof opts === "boolean") opts = { removeMeta: opts };
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			if (!driver.removeItem) return;
			await asyncCall(driver.removeItem, relativeKey, opts);
			if (opts.removeMeta || opts.removeMata) await asyncCall(driver.removeItem, relativeKey + "$", opts);
			if (!driver.watch) onChange("remove", key);
		},
		async getMeta(key, opts = {}) {
			if (typeof opts === "boolean") opts = { nativeOnly: opts };
			key = normalizeKey(key);
			const { relativeKey, driver } = getMount(key);
			const meta = Object.create(null);
			if (driver.getMeta) Object.assign(meta, await asyncCall(driver.getMeta, relativeKey, opts));
			if (!opts.nativeOnly) {
				const value = await asyncCall(driver.getItem, relativeKey + "$", opts).then((value_) => destr(value_));
				if (value && typeof value === "object") {
					if (typeof value.atime === "string") value.atime = new Date(value.atime);
					if (typeof value.mtime === "string") value.mtime = new Date(value.mtime);
					Object.assign(meta, value);
				}
			}
			return meta;
		},
		setMeta(key, value, opts = {}) {
			return this.setItem(key + "$", value, opts);
		},
		removeMeta(key, opts = {}) {
			return this.removeItem(key + "$", opts);
		},
		async getKeys(base, opts = {}) {
			base = normalizeBaseKey(base);
			const mounts = getMounts(base, true);
			let maskedMounts = [];
			const allKeys = [];
			let allMountsSupportMaxDepth = true;
			for (const mount of mounts) {
				if (!mount.driver.flags?.maxDepth) allMountsSupportMaxDepth = false;
				const rawKeys = await asyncCall(mount.driver.getKeys, mount.relativeBase, opts);
				for (const key of rawKeys) {
					const fullKey = mount.mountpoint + normalizeKey(key);
					if (!maskedMounts.some((p) => fullKey.startsWith(p))) allKeys.push(fullKey);
				}
				maskedMounts = [mount.mountpoint, ...maskedMounts.filter((p) => !p.startsWith(mount.mountpoint))];
			}
			const shouldFilterByDepth = opts.maxDepth !== void 0 && !allMountsSupportMaxDepth;
			return allKeys.filter((key) => (!shouldFilterByDepth || filterKeyByDepth(key, opts.maxDepth)) && filterKeyByBase(key, base));
		},
		async clear(base, opts = {}) {
			base = normalizeBaseKey(base);
			await Promise.all(getMounts(base, false).map(async (m) => {
				if (m.driver.clear) return asyncCall(m.driver.clear, m.relativeBase, opts);
				if (m.driver.removeItem) {
					const keys = await m.driver.getKeys(m.relativeBase || "", opts);
					return Promise.all(keys.map((key) => m.driver.removeItem(key, opts)));
				}
			}));
		},
		async dispose() {
			await Promise.all(Object.values(context.mounts).map((driver) => dispose(driver)));
		},
		async watch(callback) {
			await startWatch();
			context.watchListeners.push(callback);
			return async () => {
				context.watchListeners = context.watchListeners.filter((listener) => listener !== callback);
				if (context.watchListeners.length === 0) await stopWatch();
			};
		},
		async unwatch() {
			context.watchListeners = [];
			await stopWatch();
		},
		mount(base, driver) {
			base = normalizeBaseKey(base);
			if (base && context.mounts[base]) throw new Error(`already mounted at ${base}`);
			if (base) {
				context.mountpoints.push(base);
				context.mountpoints.sort((a, b) => b.length - a.length);
			}
			context.mounts[base] = driver;
			if (context.watching) Promise.resolve(watch(driver, onChange, base)).then((unwatcher) => {
				context.unwatch[base] = unwatcher;
			}).catch(console.error);
			return storage;
		},
		async unmount(base, _dispose = true) {
			base = normalizeBaseKey(base);
			if (!base || !context.mounts[base]) return;
			if (context.watching && base in context.unwatch) {
				context.unwatch[base]?.();
				delete context.unwatch[base];
			}
			if (_dispose) await dispose(context.mounts[base]);
			context.mountpoints = context.mountpoints.filter((key) => key !== base);
			delete context.mounts[base];
		},
		getMount(key = "") {
			key = normalizeKey(key) + ":";
			const m = getMount(key);
			return {
				driver: m.driver,
				base: m.base
			};
		},
		getMounts(base = "", opts = {}) {
			base = normalizeKey(base);
			return getMounts(base, opts.parents).map((m) => ({
				driver: m.driver,
				base: m.mountpoint
			}));
		},
		keys: (base, opts = {}) => storage.getKeys(base, opts),
		get: (key, opts = {}) => storage.getItem(key, opts),
		set: (key, value, opts = {}) => storage.setItem(key, value, opts),
		has: (key, opts = {}) => storage.hasItem(key, opts),
		del: (key, opts = {}) => storage.removeItem(key, opts),
		remove: (key, opts = {}) => storage.removeItem(key, opts)
	};
	return storage;
}
function watch(driver, onChange, base) {
	return driver.watch ? driver.watch((event, key) => onChange(event, base + key)) : () => {};
}
async function dispose(driver) {
	if (typeof driver.dispose === "function") await asyncCall(driver.dispose);
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/_chunks/node-fs.mjs
function ignoreNotfound(err) {
	return err.code === "ENOENT" || err.code === "EISDIR" ? null : err;
}
function ignoreExists(err) {
	return err.code === "EEXIST" ? null : err;
}
const TMP_FILE_PREFIX = ".unstorage-tmp-";
const TMP_FILE_RE = /^\.unstorage-tmp-[\da-z-]+$/;
const _tmpFileId = `${process.pid.toString(36)}-${randomUUID().slice(0, 8)}-`;
let _tmpFileCounter = 0;
async function writeFile(path, data, encoding, atomic) {
	const dir = dirname(path);
	await ensuredir(dir);
	if (!atomic) return promises.writeFile(path, data, encoding);
	const tmp = join(dir, TMP_FILE_PREFIX + _tmpFileId + (_tmpFileCounter++).toString(36));
	try {
		const [, destMode] = await Promise.all([promises.writeFile(tmp, data, encoding), promises.stat(path).then((s) => s.mode & 4095).catch((error) => {
			if (error.code === "ENOENT") return;
			throw error;
		})]);
		if (destMode !== void 0) await promises.chmod(tmp, destMode);
		await promises.rename(tmp, path);
	} catch (error) {
		await promises.unlink(tmp).catch(() => {});
		throw error;
	}
}
function readFile(path, encoding) {
	return promises.readFile(path, encoding).catch(ignoreNotfound);
}
function unlink(path) {
	return promises.unlink(path).catch(ignoreNotfound);
}
function readdir(dir) {
	return promises.readdir(dir, { withFileTypes: true }).catch(ignoreNotfound).then((r) => r || []);
}
async function ensuredir(dir) {
	if (existsSync(dir)) return;
	await ensuredir(dirname(dir)).catch(ignoreExists);
	await promises.mkdir(dir).catch(ignoreExists);
}
async function readdirRecursive(dir, ignore, maxDepth) {
	if (ignore && ignore(dir)) return [];
	const entries = await readdir(dir);
	const files = [];
	await Promise.all(entries.map(async (entry) => {
		const entryPath = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (maxDepth === void 0 || maxDepth > 0) {
				const dirFiles = await readdirRecursive(entryPath, ignore, maxDepth === void 0 ? void 0 : maxDepth - 1);
				files.push(...dirFiles.map((f) => entry.name + "/" + f));
			}
		} else if (!(ignore && ignore(entryPath)) && !TMP_FILE_RE.test(entry.name)) files.push(entry.name);
	}));
	return files;
}
async function rmRecursive(dir) {
	const entries = await readdir(dir);
	await Promise.all(entries.map((entry) => {
		const entryPath = resolve(dir, entry.name);
		if (entry.isDirectory()) return rmRecursive(entryPath).then(() => promises.rmdir(entryPath));
		else return promises.unlink(entryPath);
	}));
}
//#endregion
//#region ../../../../node_modules/.pnpm/unstorage@2.0.0-alpha.10/node_modules/unstorage/dist/drivers/fs-lite.mjs
const PATH_TRAVERSE_RE = /\.\.:|\.\.$/;
const DRIVER_NAME = "fs-lite";
const driver = (opts = {}) => {
	if (!opts.base) throw createRequiredError(DRIVER_NAME, "base");
	const base = resolve(opts.base);
	const r = (key) => {
		if (PATH_TRAVERSE_RE.test(key)) throw createError(DRIVER_NAME, `Invalid key: ${JSON.stringify(key)}. It should not contain .. segments`);
		return join(base, key.replace(/:/g, "/"));
	};
	return {
		name: DRIVER_NAME,
		options: {
			...opts,
			base
		},
		flags: { maxDepth: true },
		hasItem(key) {
			return existsSync(r(key));
		},
		getItem(key) {
			return readFile(r(key), "utf8");
		},
		getItemRaw(key) {
			return readFile(r(key));
		},
		async getMeta(key) {
			const { atime, mtime, size, birthtime, ctime } = await promises.stat(r(key)).catch(() => ({}));
			return {
				atime,
				mtime,
				size,
				birthtime,
				ctime
			};
		},
		setItem(key, value) {
			if (opts.readOnly) return;
			return writeFile(r(key), value, "utf8", opts.atomic);
		},
		setItemRaw(key, value) {
			if (opts.readOnly) return;
			return writeFile(r(key), value, void 0, opts.atomic);
		},
		removeItem(key) {
			if (opts.readOnly) return;
			return unlink(r(key));
		},
		getKeys(_base, topts) {
			return readdirRecursive(r("."), opts.ignore, topts?.maxDepth);
		},
		async clear() {
			if (opts.readOnly || opts.noClear) return;
			await rmRecursive(r("."));
		}
	};
};
//#endregion
export { createStorage, driver, prefixStorage };
