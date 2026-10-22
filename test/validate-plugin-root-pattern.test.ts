// F3 regression (2026-10-16 cross-environment review): the plugin validator's
// development-path leak check must treat the repository root as a complete
// path segment. A short root like /app must not hit unrelated URL fragments
// (/vocab/applicator, /apps, /app.git), while genuine absolute references —
// including file:// URLs, comment lines, and Windows backslash,
// JS-string-escaped (doubled backslash), and forward-slash forms — must
// still be rejected.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotFilesystemRoot, buildRepoRootLeakPattern } from "../scripts/lib/repo-root-pattern.mjs";

test("a short root like /app does not match unrelated URL or path segments", () => {
  const pattern = buildRepoRootLeakPattern("/app");
  const benign = [
    '"https://json-schema.org/draft/2019-09/vocab/applicator"',
    '"https://json-schema.org/draft/2019-09/vocab/applicability#items"',
    '"/apps/monitor"',
    '"/app.git/config"',
    '"/appendix/table"',
    '"/application/index.js"',
    '"myapp/src/main.ts"',
    '"./appdata/cache"',
  ];
  for (const text of benign) {
    assert.equal(pattern.test(text), false, `must not flag unrelated fragment: ${text}`);
    pattern.lastIndex = 0;
  }
});

test("genuine absolute references to a short root are still rejected", () => {
  const pattern = buildRepoRootLeakPattern("/app");
  const leaks = [
    '"/app/src/runtime/child-env.ts"',
    '"file:///app/plugins/codex-zcode-bridge/dist/bridge.mjs"',
    '"/app\\worker\\worker-main.mjs"',
    '"cwd=/app"',
    '"/bin:/app/node_modules/.bin"',
    '"/app"',
    "// /app/src/leak.ts\n",
  ];
  for (const text of leaks) {
    assert.equal(pattern.test(text), true, `must flag real development path: ${text}`);
    pattern.lastIndex = 0;
  }
});

test("URLs whose host ends before an /app path segment are not flagged", () => {
  const pattern = buildRepoRootLeakPattern("/app");
  assert.equal(pattern.test('"https://example.test/app/config"'), false);
});

test("path-structure delimiters decide the boundary, not name-character blacklists (2026-10-16 review round 2)", () => {
  const pattern = buildRepoRootLeakPattern("/app");
  // Every non-delimiter character after the root continues a longer segment.
  for (const benign of [
    '"/app@2/src/x"',
    '"/app+backup/src/x"',
    '"/app(copy)/src/x"',
    '"file:///app%20Backup/src/main.ts"',
    '"/app Backup/src/main.ts"',
    '"/app.git/config"',
  ]) {
    assert.equal(pattern.test(benign), false, `must not flag sibling segment: ${benign}`);
    pattern.lastIndex = 0;
  }
  // HTTP URL paths — first or deeper segments, plain or IPv6 hosts — are not
  // local absolute paths.
  assert.equal(pattern.test('"https://[::1]/app/config"'), false);
  assert.equal(pattern.test('"https://example.test/docs/app/config"'), false);
  // The corresponding genuine references stay flagged.
  assert.equal(pattern.test('"file:///app/src/main.ts"'), true);
  assert.equal(pattern.test('"/app/src/main.ts"'), true);
});

test("Windows roots match one separator in both backslash and forward-slash forms", () => {
  const root = "C:\\Program Files\\Bridge Dev (x86)";
  const pattern = buildRepoRootLeakPattern(root);
  assert.equal(pattern.test(`"${root}\\src\\main.ts"`), true, "backslash form must be flagged");
  assert.equal(pattern.test(`"${root.replaceAll("\\", "/")}/src/main.ts"`), true, "forward-slash form must be flagged");
  assert.equal(pattern.test(`"${root} Backup\\src\\main.ts"`), false, "sibling directory with a suffix must not be flagged");
  assert.equal(pattern.test(`"${root}2\\src\\main.ts"`), false, "sibling directory with a digit suffix must not be flagged");
  assert.equal(pattern.test('"C:\\Program Files\\BridgeDev\\src\\main.ts"'), false, "different directory must not be flagged");
});

test("JS-string-escaped Windows paths and absolute comments are rejected (2026-10-16 review round 2)", () => {
  const root = "C:\\Program Files\\Bridge Dev";
  const pattern = buildRepoRootLeakPattern(root);
  // Bundles embed absolute paths inside JS strings, where each backslash is
  // doubled; both spellings name the same development path.
  assert.equal(pattern.test(JSON.stringify(`${root}\\src\\leak.ts`)), true, "escaped (doubled backslash) form must be flagged");
  assert.equal(pattern.test(`// ${root}\\src\\leak.ts\n`), true, "comment with a separating space before the path must be flagged");
  assert.equal(
    pattern.test(JSON.stringify(`${root} Backup\\src\\main.ts`)),
    false,
    "escaped sibling directory with a space suffix must not be flagged",
  );
});

test("roots with unicode or regex metacharacters stay escaped and bounded", () => {
  const root = "/home/开发者/bridge[v2](副本)";
  const pattern = buildRepoRootLeakPattern(root);
  assert.equal(pattern.test(`"${root}/src/a.ts"`), true, "exact unicode root leak must be flagged");
  assert.equal(pattern.test(`"${root}备份/src/a.ts"`), false, "unicode suffix extends the segment; not this root");
  assert.equal(pattern.test('"/home/开发者/bridgev2/src/a.ts"'), false, "metacharacters must stay literal");
});

test("the standard file URI spelling of the root is rejected, its encoded sibling suffix is not", () => {
  const root = "C:\\Program Files\\Bridge Dev 修订";
  const pattern = buildRepoRootLeakPattern(root);
  assert.equal(pattern.test(pathToFileURL(path.join(root, "src", "leak.ts")).href), true, "pathToFileURL form must be flagged");
  assert.equal(
    pattern.test(pathToFileURL(path.join(`${root} Backup`, "src", "main.ts")).href),
    false,
    "percent-encoded sibling suffix (%20Backup) must not be flagged",
  );
  const shortRoot = buildRepoRootLeakPattern("/app");
  assert.equal(shortRoot.test('"file:///app/src/main.ts"'), true, "short-root file URI reference must be flagged");
  assert.equal(shortRoot.test('"file:///app%20Backup/src/main.ts"'), false, "short-root encoded sibling suffix must not be flagged");
  // pathToFileURL on Windows prepends the current drive for POSIX-style roots;
  // the sibling suffix must stay a non-match in that spelling too.
  assert.equal(shortRoot.test(pathToFileURL("/app Backup/src/main.ts").href), false, "native-drive encoded sibling suffix must not be flagged");
  assert.equal(shortRoot.test(pathToFileURL("/app/src/main.ts", { windows: false }).href), true, "cross-platform file URI spelling must be flagged");
});

test("a file URI embedded inside an HTTP URL is still rejected (raw branch is suppressed, the file URI branch is not)", () => {
  const root = "E:/Programs/example repository";
  const pattern = buildRepoRootLeakPattern(root);
  const uri = pathToFileURL(`${root}/src/leak.ts`).href;
  assert.equal(
    pattern.test(JSON.stringify(`https://example.test/redirect?target=${uri}`)),
    true,
    "http-wrapped file URI reference to the development path must be flagged",
  );
  // Ordinary HTTP URLs stay clean even with deeper path segments.
  assert.equal(pattern.test('"https://example.test/redirect?target=/docs/app/config"'), false);
  const shortRoot = buildRepoRootLeakPattern("/app");
  assert.equal(shortRoot.test(JSON.stringify("https://example.test/redirect?target=file:///app/src")), true);
});

test("root matching keeps case-insensitivity for Windows-style roots", () => {
  const pattern = buildRepoRootLeakPattern("/App");
  assert.equal(pattern.test('"/app/src"'), true);
  assert.equal(pattern.test('"/APP/src"'), true);
});

test("a repeated probe does not skip later matches (no sticky/global state)", () => {
  const pattern = buildRepoRootLeakPattern("/app");
  assert.equal(pattern.test('"https://json-schema.org/draft/2019-09/vocab/applicator"'), false);
  assert.equal(pattern.test('"/app/src/leak.ts"'), true);
  assert.equal(pattern.test('"https://json-schema.org/draft/2019-09/vocab/applicability"'), false);
});

test("filesystem roots are rejected with an explanation instead of silently disabling the leak check (2026-10-17)", () => {
  const filesystemRoots = [
    ["/", "POSIX"],
    ["//", "POSIX"],
    ["///", "POSIX"],
    ["/./", "normalized POSIX"],
    ["/alpha/..", "normalized POSIX"],
    ["/a/../..", "normalized POSIX"],
    ["C:\\", "drive"],
    ["C:", "drive"],
    ["C:/", "drive"],
    ["c:\\", "drive"],
    ["C:\\\\", "drive (repeated separators)"],
    ["c:/./", "normalized drive"],
    ["C:/alpha/..", "normalized drive"],
    ["\\\\?\\C:\\", "extended drive"],
    ["\\\\?\\C:/", "extended drive"],
    ["\\\\.\\C:\\", "device drive"],
    ["\\\\server\\share", "share"],
    ["\\\\server\\share\\", "share"],
    ["\\\\server\\share\\repo\\..", "normalized share"],
    ["\\\\?\\UNC\\server\\share", "extended share"],
  ] as const;
  for (const [root, kind] of filesystemRoots) {
    assert.throws(
      () => buildRepoRootLeakPattern(root),
      (error: unknown) => {
        assert.ok(error instanceof Error, `${kind} root ${JSON.stringify(root)} must be rejected with an Error`);
        assert.match(error.message, /filesystem root/u, "the rejection must say it is a filesystem root");
        assert.match(error.message, /false positive/u, "the rejection must explain why the check is meaningless");
        assert.ok(error.message.includes(JSON.stringify(root)), "the rejection must name the rejected input");
        if (kind.startsWith("normalized")) {
          assert.match(error.message, /lexically equivalent/u, `normalized spelling ${JSON.stringify(root)} must say which root it collapses to`);
        }
        return true;
      },
      `${kind} root ${JSON.stringify(root)} must be rejected`,
    );
  }
  // Non-string and blank inputs are refused for the same reason: no silent skip.
  for (const invalid of [undefined, null, 0, "", "   "]) {
    assert.throws(() => buildRepoRootLeakPattern(invalid as string), /non-empty repository root/u, `invalid root ${JSON.stringify(invalid)} must be refused`);
  }
});

test("roots one level below a filesystem root keep building usable patterns", () => {
  const nearRoots = [
    "/app",
    "/home/开发者",
    "/a/b/../c",
    "C:\\Program Files\\Bridge Dev (x86)",
    "C:\\repo",
    "C:\\repo\\..\\repo2",
    "D:\\x",
    "\\\\server\\share\\repo",
    "\\\\server\\share\\repo\\..\\repo2",
    "\\\\?\\C:\\repo",
    "E:/Programs/example repository",
  ];
  for (const root of nearRoots) {
    let pattern: RegExp | undefined;
    assert.doesNotThrow(() => { pattern = buildRepoRootLeakPattern(root); }, `root ${JSON.stringify(root)} is a checkout path and must build`);
    assert.ok(pattern instanceof RegExp);
    if (root === "D:\\x") {
      assert.equal(pattern.test('"D:\\\\x\\\\src\\\\leak.ts"'), true, "a one-level drive path still detects its own leaks");
      assert.equal(pattern.test('"D:\\\\y\\\\src\\\\leak.ts"'), false, "and still ignores sibling directories");
    }
  }
  // Sanity: the guard is exported so hosts can share the exact semantics.
  assert.doesNotThrow(() => assertNotFilesystemRoot("/app"));
  assert.throws(() => assertNotFilesystemRoot("/"), /filesystem root/u);
  assert.throws(() => assertNotFilesystemRoot("/alpha/.."), /lexically equivalent/u);
});

test("an HTTP URL whose host equals a short root is not a development-path leak (2026-10-17)", () => {
  const pattern = buildRepoRootLeakPattern("/app");
  for (const url of [
    '"https://app/config"',
    '"http://app/x"',
    '"https://app.example/config"',
    '"https://app#fragment"',
  ]) {
    assert.equal(pattern.test(url), false, `an ordinary URL must not be flagged: ${url}`);
    pattern.lastIndex = 0;
  }
  // The genuine references on the same short root stay flagged.
  for (const leak of [
    '"/app/src/main.ts"',
    JSON.stringify("file:///app/src/main.ts"),
    '"// /app/src/leak.ts\n"',
    '"/app"',
  ]) {
    assert.equal(pattern.test(leak), true, `a genuine reference must stay flagged: ${leak}`);
    pattern.lastIndex = 0;
  }
});

/**
 * Runs the real scripts/validate-plugin.mjs against a fixture repository
 * (space + unicode + regex characters in the root name) with the current
 * scripts/lib/repo-root-pattern.mjs, mirroring the Codex review's CLI probes:
 * the baseline copy must validate cleanly, and injected development-path
 * references (escaped string literal, comment, forward-slash, file URL) must
 * be rejected specifically by the absolute-path leak check.
 */
test("the real validator rejects injected development-path references and keeps the baseline clean", { timeout: 120_000 }, () => {
  const scriptsDir = fileURLToPath(new URL("../../scripts/", import.meta.url));
  const tempBase = mkdtempSync(path.join(tmpdir(), "bridge-validate-plugin-cli-"));
  assert.ok(tempBase.startsWith(tmpdir()), "fixture must live under the system temp directory");
  const root = path.join(tempBase, `bridge 修订 (v2)[x]`);
  try {
    const pluginRoot = path.join(root, "plugins", "codex-zcode-bridge");
    for (const directory of [
      path.join(root, "scripts", "lib"),
      path.join(pluginRoot, ".codex-plugin"),
      path.join(pluginRoot, "dist"),
      path.join(pluginRoot, "worker", "vendor", "pkg"),
      path.join(pluginRoot, "hooks"),
      path.join(pluginRoot, "skills", "zcode-bridge"),
      path.join(pluginRoot, "scripts"),
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    copyFileSync(path.join(scriptsDir, "validate-plugin.mjs"), path.join(root, "scripts", "validate-plugin.mjs"));
    copyFileSync(path.join(scriptsDir, "lib", "repo-root-pattern.mjs"), path.join(root, "scripts", "lib", "repo-root-pattern.mjs"));

    const manifest = { name: "codex-zcode-bridge", version: "1.2.5" };
    const mcp = { mcpServers: { zcode_bridge: { command: "node", args: ["./dist/bridge.mjs"], env: { ZCODE_BRIDGE_PLUGIN_MODE: "1" } } } };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify(manifest));
    writeFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
    writeFileSync(path.join(pluginRoot, "mcp.json"), JSON.stringify(mcp));
    writeFileSync(path.join(pluginRoot, ".mcp.json"), JSON.stringify(mcp));
    writeFileSync(path.join(pluginRoot, "worker", "vendor", "package.json"), JSON.stringify({ name: "playwright-core" }));
    writeFileSync(path.join(pluginRoot, "worker", "vendor", "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium" }] }));
    for (const file of ["hooks/hooks.json", "hooks/session-start.mjs", "hooks/configure-runtime.ps1", "skills/zcode-bridge/SKILL.md", "scripts/wait-task.mjs"]) {
      writeFileSync(path.join(pluginRoot, file), "");
    }

    const leakPath = path.join(root, "src", "leak.ts");
    const forwardLeak = leakPath.split(path.sep).join("/");
    const baseline = [
      'const schema = "https://json-schema.org/draft/2019-09/vocab/applicator";',
      'const sameSegment = "https://example.test/app/config";',
      `const sibling = ${JSON.stringify(`${root} Backup${path.sep}src${path.sep}main.ts`)};`,
      `const encodedSibling = ${JSON.stringify(pathToFileURL(path.join(`${root} Backup`, "src", "main.ts")).href)};`,
      "// vendor loader keeps worker/vendor/pkg/browser-host.cjs self-contained",
    ].join("\n");
    const bundlePath = path.join(pluginRoot, "dist", "bridge.mjs");
    writeFileSync(path.join(pluginRoot, "worker", "worker-main.mjs"), `${baseline}\n`, "utf8");
    writeFileSync(path.join(pluginRoot, "worker", "vendor", "pkg", "browser-host.cjs"), `${baseline}\n`, "utf8");

    const variants: Array<[name: string, injection: string, expectLeakDiagnostic: boolean]> = [
      ["baseline", "", false],
      ["escaped windows absolute", `const leak = ${JSON.stringify(leakPath)};\n`, true],
      ["absolute comment", `// ${leakPath}\n`, true],
      ["forward slash form", `// ${forwardLeak}\n`, true],
      ["standard file uri form", `const uri = ${JSON.stringify(pathToFileURL(leakPath).href)};\n`, true],
      ["http-wrapped file uri form", `const redirect = ${JSON.stringify(`https://example.test/redirect?target=${pathToFileURL(leakPath).href}`)};\n`, true],
    ];
    for (const [name, injection, expectLeakDiagnostic] of variants) {
      writeFileSync(bundlePath, `${baseline}\n${injection}`, "utf8");
      const run = spawnSync(process.execPath, [path.join(root, "scripts", "validate-plugin.mjs")], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const hasLeakDiagnostic = output.includes("embeds the development repository's absolute path");
      if (expectLeakDiagnostic) {
        assert.notEqual(run.status, 0, `${name}: validator must reject the injected development path`);
        assert.equal(hasLeakDiagnostic, true, `${name}: rejection must come from the absolute-path leak check`);
      } else {
        assert.equal(run.status, 0, `${name}: baseline must validate cleanly (stderr: ${output.trim().slice(0, 300)})`);
        assert.equal(hasLeakDiagnostic, false, `${name}: benign content must not trip the leak check`);
      }
    }
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
});
