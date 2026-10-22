import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoRootLeakPattern } from "./lib/repo-root-pattern.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "codex-zcode-bridge");

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const pkg = await readJson(path.join(root, "package.json"), "package.json");
const plugin = await readJson(path.join(pluginRoot, "plugin.json"), "plugin.json");
const codexPlugin = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), ".codex-plugin/plugin.json");
const portableMcp = await readJson(path.join(pluginRoot, "mcp.json"), "mcp.json");
const codexMcp = await readJson(path.join(pluginRoot, ".mcp.json"), ".mcp.json");

for (const [label, manifest] of [["plugin.json", plugin], [".codex-plugin/plugin.json", codexPlugin]]) {
  const hasLocalCachebuster =
    label === ".codex-plugin/plugin.json" &&
    typeof manifest.version === "string" &&
    manifest.version.startsWith(`${pkg.version}+codex.`) &&
    /^[a-z0-9-]+$/.test(manifest.version.slice(`${pkg.version}+codex.`.length));
  if (manifest.name !== pkg.name || (manifest.version !== pkg.version && !hasLocalCachebuster)) {
    throw new Error(`${label} identity/version must match package.json (${pkg.name}@${pkg.version})`);
  }
}
for (const [label, mcp] of [["mcp.json", portableMcp], [".mcp.json", codexMcp]]) {
  const server = mcp.mcpServers?.zcode_bridge;
  if (server?.command !== "node" || !Array.isArray(server.args) || server.args[0] !== "./dist/bridge.mjs") {
    throw new Error(`${label} must launch ./dist/bridge.mjs with node`);
  }
  if (server.env?.ZCODE_BRIDGE_PLUGIN_MODE !== "1") {
    throw new Error(`${label} must set ZCODE_BRIDGE_PLUGIN_MODE=1`);
  }
}

for (const relativePath of [
  "dist/bridge.mjs",
  "worker/worker-main.mjs",
  "worker/vendor/pkg/browser-host.cjs",
  "worker/vendor/browsers.json",
  "worker/vendor/package.json",
  "hooks/hooks.json",
  "hooks/session-start.mjs",
  "hooks/configure-runtime.ps1",
  "skills/zcode-bridge/SKILL.md",
  "scripts/wait-task.mjs",
]) {
  await access(path.join(pluginRoot, relativePath));
}

// The waiter runs straight from the installed plugin (ADR-010), so it may only
// import Node built-ins.
const waiter = await readFile(path.join(pluginRoot, "scripts", "wait-task.mjs"), "utf8");
for (const match of waiter.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)) {
  if (!match[1].startsWith("node:")) throw new Error(`scripts/wait-task.mjs must import only node: built-ins (found ${match[1]})`);
}

// The installed plugin must load without the development checkout: bundles
// must not embed the repository's absolute path, and the ESM bundles must not
// statically import playwright-core — the pinned runtime ships only inside
// the vendored CommonJS backend, which resolves its registry data relative to
// its own directory (module-label comments inside the bundle legitimately
// mention the packaging path and are not an external dependency).
const repoRootPattern = buildRepoRootLeakPattern(root);
for (const relativePath of ["dist/bridge.mjs", "worker/worker-main.mjs", "worker/vendor/pkg/browser-host.cjs"]) {
  const bundle = await readFile(path.join(pluginRoot, relativePath), "utf8");
  if (repoRootPattern.test(bundle)) {
    throw new Error(`${relativePath} embeds the development repository's absolute path`);
  }
}
for (const relativePath of ["dist/bridge.mjs", "worker/worker-main.mjs"]) {
  const bundle = await readFile(path.join(pluginRoot, relativePath), "utf8");
  if (/(?:from|import)\s*["']playwright-core["']/u.test(bundle)) {
    throw new Error(`${relativePath} statically imports playwright-core; the browser backend must load through the vendored bundle`);
  }
}
const vendorPackage = await readJson(path.join(pluginRoot, "worker", "vendor", "package.json"), "worker/vendor/package.json");
if (vendorPackage.name !== "playwright-core") {
  throw new Error("worker/vendor/package.json must be the vendored playwright-core package manifest");
}
const vendorBrowsers = await readJson(path.join(pluginRoot, "worker", "vendor", "browsers.json"), "worker/vendor/browsers.json");
if (!Array.isArray(vendorBrowsers.browsers) || vendorBrowsers.browsers.length === 0) {
  throw new Error("worker/vendor/browsers.json must be the vendored playwright-core registry data");
}
const workerBundle = await readFile(path.join(pluginRoot, "worker", "worker-main.mjs"), "utf8");
if (!workerBundle.includes("vendor") || !workerBundle.includes("browser-host.cjs")) {
  throw new Error("worker-main.mjs no longer references the vendored browser backend; update the loader or this check");
}

console.log(`Plugin package is structurally valid (${plugin.name}@${plugin.version}).`);

