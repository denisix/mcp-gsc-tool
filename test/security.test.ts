import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { startLocalCallbackServer } from "../src/oauth.ts";

test("OAuth callback rejects wrong or missing state, accepts the right one", async () => {
  const port = 49000 + Math.floor(Math.random() * 1000);
  const p = startLocalCallbackServer(port, "s3cret");
  await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${port}/`;
  assert.equal((await fetch(base + "?code=evil&state=nope")).status, 400);
  assert.equal((await fetch(base + "?error=access_denied")).status, 400); // can't abort the flow either
  assert.equal((await fetch(base + "?code=good&state=s3cret")).status, 200);
  assert.equal(await p, "good");
});

test("no process-global googleapis auth (#15)", () => {
  const hits: string[] = [];
  const walk = (d: string): void => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (f.endsWith(".ts") && fs.readFileSync(f, "utf8").includes("google.options(")) hits.push(f);
  });
  walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(hits, []);
});

test("token file is written owner-only", () => {
  // Fresh process and an explicit token dir: never touch the real ~/.search-console-mcp.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-home-"));
  const mod = new URL("../src/oauth.ts", import.meta.url).href;
  execFileSync(process.execPath, ["-e", `(await import(${JSON.stringify(mod)})).saveCachedToken({a:1})`],
    { env: { ...process.env, GSC_TOKEN_DIR: path.join(home, "tokens") } });
  const st = fs.statSync(path.join(home, "tokens", "oauth-token.json"));
  assert.equal(st.mode & 0o777, 0o600);
  fs.rmSync(home, { recursive: true });
});
