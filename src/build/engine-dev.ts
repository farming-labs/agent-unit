import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { builtinDrivers, createStorage, type Driver } from "unstorage";
import { redisCoordination, type RedisLike } from "@agent-unit/runtime/redis";
import { RunStore } from "@agent-unit/runtime/runtime";
import { createAgentUnit } from "@agent-unit/runtime/server";
import type { StorageConfig } from "../config";
import { loadAgents } from "./agents";
import type { DevApp } from "./dev";
import { DEFAULT_STORAGE, withSafeDefaults } from "./engine";
import type { LoadedProject } from "./load";

/** The storage driver the build would mount: one of unstorage's by name or alias, or a module of the app's. */
async function loadDriver(root: string, config: StorageConfig): Promise<Driver> {
  const { driver, ...options } = withSafeDefaults(config);
  const builtin = (builtinDrivers as Record<string, string>)[driver];
  const module = (
    builtin
      ? await import(builtin)
      : await createJiti(join(root, "package.json"), { moduleCache: false, fsCache: false }).import(/^[./]/.test(driver) ? resolve(root, driver) : driver)
  ) as { default: (options: unknown) => Driver };
  if (typeof module.default !== "function") throw new Error(`agent-unit: the storage driver "${driver}" must export default a driver factory.`);
  // Relative fs paths resolve against the app root, matching the built server's working directory.
  if (typeof options.base === "string" && /^(fs|fs-lite)$/.test(driver)) options.base = resolve(root, options.base);
  return module.default(options);
}

/** agent-unit's engine serving the app's agents from source, as the built server does. */
export async function createEngineApp(project: LoadedProject): Promise<DevApp> {
  const { agents, adapters } = await loadAgents(project);
  const driver = await loadDriver(project.root, project.config.storage ?? DEFAULT_STORAGE);
  const plain = createStorage({ driver });
  const redis = driver as Driver & { getInstance?: () => unknown; options?: { base?: string } };
  // On Redis, runs and leases change atomically, as they do in the built server.
  const storage =
    driver.name === "redis" && typeof redis.getInstance === "function"
      ? new RunStore(plain, redisCoordination({ client: () => redis.getInstance!() as RedisLike, base: redis.options?.base }))
      : plain;
  const unit = createAgentUnit({
    name: project.name,
    agents,
    adapters,
    storage,
    budget: project.config.budget,
    basePath: project.config.basePath,
    authorize: project.config.authorize,
    origin: project.config.origin,
    retention: project.config.retention,
    maxBodyBytes: project.config.maxBodyBytes,
  });
  return {
    unit,
    fetch: (request, waitUntil) => unit.handler(request, { waitUntil }),
    describe: () => unit.engine.manifest().agents.map((agent) => `${agent.name} (${agent.framework})`).join(", "),
    // Wake sleepers and recover stalled runs, as the scheduled sweep does in production.
    sweep: () => unit.engine.sweep(),
    close: () => unit.close(),
  };
}
