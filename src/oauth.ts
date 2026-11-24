import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { cachedTokenSource, type TokenSource, tokenRequest } from "./google.js";
import { EMBEDDED_CLIENT_ID, EMBEDDED_CLIENT_SECRET, embeddedClientAvailable } from "./embedded-client.js";

const TOKEN_DIR = path.join(os.homedir(), ".gsc-mcp");
const TOKEN_PATH = path.join(TOKEN_DIR, "oauth-token.json");

export type ScopeTier = "readonly" | "full";

/**
 * GSC_SCOPES=readonly requests only webmasters.readonly, which keeps the
 * Google consent screen to a single read-only permission. The default is
 * "full" (read + sitemap submission + Indexing API) so existing installs
 * keep working exactly as before this option existed.
 */
export function getScopeTier(): ScopeTier {
  return process.env.GSC_SCOPES?.toLowerCase() === "readonly" ? "readonly" : "full";
}

export function scopesForTier(tier: ScopeTier): string[] {
  if (tier === "readonly") {
    return ["https://www.googleapis.com/auth/webmasters.readonly"];
  }
  return [
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/webmasters",
    // Required for the submit_url / submit_batch tools (Indexing API).
    // Without this scope the token issued by the OAuth flow cannot call
    // indexing.urlNotifications.publish, and submissions fail with
    // "Insufficient Permission" even when the Indexing API is enabled.
    "https://www.googleapis.com/auth/indexing",
  ];
}

export function clearCachedToken(): void {
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  } catch {
    // best effort
  }
}

export function tokenPath(): string {
  return TOKEN_PATH;
}

// Concurrency guard: if an OAuth flow is already in progress, reuse its promise
let activeAuthPromise: Promise<any> | null = null;

function ensureTokenDir(): void {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadCachedToken(): any | null {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const raw = fs.readFileSync(TOKEN_PATH, "utf8");
      return JSON.parse(raw);
    }
  } catch {
    // corrupted token file, will re-auth
  }
  return null;
}

export function saveCachedToken(token: any): void {
  ensureTokenDir();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600); // mode only applies on create; tighten tokens written by older versions too
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function getOAuthConfig(): OAuthConfig {
  // Option 1: direct env vars
  const clientId = process.env.GSC_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GSC_OAUTH_CLIENT_SECRET;

  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }

  // Option 2: secrets file
  const secretsFile = process.env.GSC_OAUTH_SECRETS_FILE;
  if (secretsFile && fs.existsSync(secretsFile)) {
    const raw = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
    const creds = raw.installed || raw.web;
    if (creds) {
      return {
        clientId: creds.client_id,
        clientSecret: creds.client_secret,
      };
    }
  }

  // Option 3: the embedded public client (see embedded-client.ts)
  if (embeddedClientAvailable()) {
    return { clientId: EMBEDDED_CLIENT_ID, clientSecret: EMBEDDED_CLIENT_SECRET };
  }

  throw new Error(
    "OAuth credentials not found. Run `bun src/index.ts setup` for guided configuration, " +
    "or set GSC_OAUTH_CLIENT_ID and GSC_OAUTH_CLIENT_SECRET, " +
    "or set GSC_OAUTH_SECRETS_FILE to a Google OAuth client secrets JSON file."
  );
}

/**
 * True when the cached token was granted every scope the current tier needs.
 * A token minted in read-only mode cannot call write APIs, so switching
 * GSC_SCOPES to "full" must trigger a fresh consent rather than a silent 403.
 */
function cachedTokenCoversScopes(cachedToken: any): boolean {
  const needed = scopesForTier(getScopeTier());
  const granted: string[] = typeof cachedToken?.scope === "string" ? cachedToken.scope.split(" ") : [];
  if (granted.length === 0) {
    // Tokens cached before v2.3 carried no scope field; they were always
    // granted the full set, so treat them as covering everything.
    return true;
  }
  return needed.every((s) => granted.includes(s));
}

/**
 * Starts a one-shot local HTTP server to capture the OAuth redirect.
 * Returns the authorization code.
 */
/** Opens url in the default browser. Args are passed without a shell, so the URL is never interpreted. */
function openBrowser(url: string): void {
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] // not `start`: cmd would split on &
    : ["xdg-open", url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.error("Could not open browser automatically. Please visit the URL above."));
  child.unref();
}

export function startLocalCallbackServer(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      // CSRF guard: ignore any callback that doesn't carry our state, so a stray page can't inject or abort the login.
      if (url.searchParams.get("state") !== expectedState) {
        res.writeHead(400);
        res.end("Invalid state");
        return;
      }

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authentication failed.</h2><p>You can close this tab.</p></body></html>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authentication successful!</h2><p>You can close this tab and return to your MCP client.</p></body></html>");
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400);
      res.end("Missing code parameter");
    });

    server.listen(port, "127.0.0.1", () => {
      console.error(`OAuth callback server listening on http://127.0.0.1:${port}`);
    });

    server.on("error", reject);

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth authentication timed out after 2 minutes"));
    }, 120000).unref();
  });
}

const CALLBACK_PORT = 3847;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}`;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's token response -> the cached format (google-auth-library's, so existing caches keep working). */
function toCachedToken(t: any, previous: any = {}): any {
  return {
    ...previous,
    access_token: t.access_token,
    // Google omits refresh_token on refresh responses; keep the one we have.
    refresh_token: t.refresh_token ?? previous.refresh_token,
    scope: t.scope ?? previous.scope,
    token_type: t.token_type ?? "Bearer",
    expiry_date: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
}

/**
 * OAuth access tokens for the configured client: uses the cached token, refreshes it
 * when it expires (also mid-session), and falls back to the browser flow when
 * there is no usable token or the refresh token was revoked.
 */
export async function authenticateWithOAuth(): Promise<TokenSource> {
  const config = getOAuthConfig();
  let token = loadCachedToken();
  if (token && !cachedTokenCoversScopes(token)) {
    console.error("Cached token is missing scopes the current GSC_SCOPES tier needs, re-authenticating...");
    token = null;
  }
  token ??= await runBrowserAuth(config);

  return cachedTokenSource(async () => {
    if (token.access_token && token.expiry_date && token.expiry_date - 60_000 > Date.now()) {
      return { token: token.access_token, expiresAt: token.expiry_date };
    }
    if (token.refresh_token) {
      try {
        token = toCachedToken(
          await tokenRequest({
            grant_type: "refresh_token",
            refresh_token: token.refresh_token,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
          token
        );
        saveCachedToken(token);
        console.error("OAuth token refreshed successfully");
        return { token: token.access_token, expiresAt: token.expiry_date };
      } catch (err) {
        console.error(`Token refresh failed (${(err as Error).message}), re-authenticating...`);
      }
    }
    token = await runBrowserAuth(config);
    return { token: token.access_token, expiresAt: token.expiry_date };
  });
}

/** Browser sign-in with state (CSRF) and PKCE (S256); returns and caches the new token. */
async function runBrowserAuth(config: OAuthConfig): Promise<any> {
  // If an auth flow is already running, wait for it instead of starting a second server
  if (activeAuthPromise) {
    console.error("OAuth flow already in progress, waiting for it to complete...");
    return activeAuthPromise;
  }

  activeAuthPromise = (async () => {
    try {
      const state = randomBytes(16).toString("hex");
      const verifier = randomBytes(32).toString("base64url");
      const authUrl = `${AUTH_URL}?${new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: scopesForTier(getScopeTier()).join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })}`;

      // Start callback server before opening browser
      const codePromise = startLocalCallbackServer(CALLBACK_PORT, state);

      console.error(`\nOpening browser for Google authentication...\nIf the browser doesn't open, visit this URL:\n${authUrl}\n`);
      openBrowser(authUrl);

      const code = await codePromise;
      const token = toCachedToken(
        await tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: REDIRECT_URI,
        })
      );
      saveCachedToken(token);
      console.error("OAuth authentication successful, token cached");
      return token;
    } finally {
      activeAuthPromise = null;
    }
  })();

  return activeAuthPromise;
}
