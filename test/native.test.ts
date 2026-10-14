import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foreignNativePackages } from "../src/build/native";
import { vercelRuntime } from "../src/build/nitro";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function serverDir(packages: Record<string, Record<string, unknown> | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "agent-unit-native-"));
  dirs.push(dir);
  for (const [name, manifest] of Object.entries(packages)) {
    const pkg = join(dir, "node_modules", ...name.split("/"));
    mkdirSync(pkg, { recursive: true });
    if (manifest) writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: name.split("/node_modules/").at(-1), ...manifest }));
  }
  return dir;
}

describe("a build's native packages for another system", () => {
  it("finds packages that do not run on Linux, scoped and nested, and nothing else", () => {
    const dir = serverDir({
      "@libsql/darwin-arm64": { os: ["darwin"], cpu: ["arm64"] },
      "@libsql/linux-x64-gnu": { os: ["linux"], cpu: ["x64"] },
      "fsevents": { os: ["!linux", "!win32"] },
      "libsql/node_modules/@img/sharp-win32-x64": { os: ["win32"] },
      "plain": {},
      "no-manifest": undefined,
      "everywhere-but-windows": { os: ["!win32"] },
    });
    expect(foreignNativePackages(dir)).toEqual(["@img/sharp-win32-x64", "@libsql/darwin-arm64", "fsevents"]);
  });

  it("finds nothing in a build without node_modules", () => {
    expect(foreignNativePackages(serverDir({}))).toEqual([]);
    expect(foreignNativePackages(join(tmpdir(), "agent-unit-native-missing"))).toEqual([]);
  });
});

describe("the Vercel function runtime", () => {
  it("moves a build on Node 20 to a runtime Vercel offers, and keeps the app's own", () => {
    expect(vercelRuntime(undefined, "20.19.0")).toBe("nodejs22.x");
    expect(vercelRuntime(undefined, "22.12.0")).toBeUndefined();
    expect(vercelRuntime(undefined, "24.1.0")).toBeUndefined();
    expect(vercelRuntime("nodejs24.x", "20.19.0")).toBeUndefined();
  });
});
