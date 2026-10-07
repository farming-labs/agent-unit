import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// How each host runs a build, shared by the per-host suites and the framework × host matrix.

/** The workerd binary itself, not the package's Node launcher: killing the launcher would leave the
 * runtime running, and a "restart" would quietly keep talking to the old process. */
export const workerd: string | undefined = await import("workerd").then(
  // Node's CommonJS interop wraps the export; Vite's unwraps it.
  (module) => (typeof module.default === "string" ? module.default : (module.default as unknown as { default: string }).default),
  () => undefined,
);

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));

/** A workerd config from a durable-objects build's wrangler.json: its Durable Object bindings, kept on local disk. */
export function writeDurableConfig(out: string, disk: string, port: number, vars: Record<string, string> = {}) {
  const serverDir = join(out, "server");
  const wrangler = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
  const modules = files(serverDir)
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => relative(serverDir, file).replaceAll("\\", "/"))
    .sort((a, b) => (a === wrangler.main ? -1 : b === wrangler.main ? 1 : a.localeCompare(b)))
    .map((name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(`server/${name}`)})`);
  const objects: { name: string; class_name: string }[] = wrangler.durable_objects.bindings;
  const sqlite = new Set<string>(wrangler.migrations.flatMap((migration: { new_sqlite_classes?: string[] }) => migration.new_sqlite_classes ?? []));
  const bindings = [
    ...objects.map((object) => `(name = ${JSON.stringify(object.name)}, durableObjectNamespace = ${JSON.stringify(object.class_name)})`),
    ...Object.entries(vars).map(([name, value]) => `(name = ${JSON.stringify(name)}, text = ${JSON.stringify(value)})`),
  ];
  const namespaces = objects.map(
    (object) => `(className = ${JSON.stringify(object.class_name)}, uniqueKey = ${JSON.stringify(`e2e-${object.class_name}`)}, enableSql = ${sqlite.has(object.class_name)})`,
  );
  const config = join(out, "workerd.capnp");
  writeFileSync(
    config,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .worker), (name = "do-disk", disk = (path = ${JSON.stringify(disk)}, writable = true))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  modules = [${modules.join(",\n    ")}],
  compatibilityDate = ${JSON.stringify(wrangler.compatibility_date)},
  compatibilityFlags = ${JSON.stringify(wrangler.compatibility_flags)},
  bindings = [${bindings.join(", ")}],
  durableObjectNamespaces = [${namespaces.join(", ")}],
  durableObjectStorage = (localDisk = "do-disk"),
);
`,
  );
  return { config, wrangler };
}

/** A serverless function bundle, called in-process the way its platform calls it. */
export interface FunctionHost {
  preset: string;
  /** Path of the function module inside the output directory. */
  entry: string;
  /** Whether the platform keeps work alive after the response (waitUntil). */
  waitUntil: boolean;
  /** Calls the built function with a Web request, the way the platform would. */
  invoke(module: Record<string, any>, request: Request, waitUntil: (promise: Promise<unknown>) => void): Promise<Response>;
}

export const vercel: FunctionHost = {
  preset: "vercel",
  entry: "functions/__server.func/index.mjs",
  waitUntil: true,
  invoke: (module, request, waitUntil) => module.default.fetch(request, { waitUntil }),
};

export const netlify: FunctionHost = {
  preset: "netlify",
  entry: "server/server.mjs",
  waitUntil: false,
  invoke: (module, request) => module.default(request, {}),
};

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

export const lambda: FunctionHost = {
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
};
