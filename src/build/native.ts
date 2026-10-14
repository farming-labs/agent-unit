import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Packages in a build's traced `node_modules` that declare, in package.json's `os` field, that they run
 * only on systems other than `target`: native binaries for the machine that built it, which the host
 * cannot load (libsql's `@libsql/darwin-arm64` on a Linux function, for example).
 */
export function foreignNativePackages(serverDir: string, target = "linux"): string[] {
  const found = new Set<string>();
  const visit = (modules: string, depth: number) => {
    if (depth > 8 || !existsSync(modules)) return;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dirs = entry.name.startsWith("@")
        ? readdirSync(join(modules, entry.name), { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => [`${entry.name}/${child.name}`, join(modules, entry.name, child.name)] as const)
        : [[entry.name, join(modules, entry.name)] as const];
      for (const [name, dir] of dirs) {
        try {
          const { os } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { os?: string[] };
          if (Array.isArray(os) && os.length && !runsOn(os, target)) found.add(name);
        } catch {
          // No package.json (a traced subset of a package): nothing to check.
        }
        visit(join(dir, "node_modules"), depth + 1);
      }
    }
  };
  visit(join(serverDir, "node_modules"), 0);
  return [...found].sort();
}

/** Whether npm's `os` list (`["darwin"]`, `["!win32"]`) allows `target`. */
function runsOn(os: string[], target: string): boolean {
  if (os.includes(`!${target}`)) return false;
  const allowed = os.filter((entry) => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(target);
}
