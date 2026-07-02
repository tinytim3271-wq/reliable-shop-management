import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  qboConnectionsTable,
  type QboConnection,
  type QboAccountMapping,
} from "@workspace/db";
import { resolveSessionSecret } from "./sessionSecret";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// QuickBooks Online OAuth + REST client
//
// This module is a self-contained Intuit OAuth 2.0 client. RSS is a SOLD,
// standalone product: each shop owner connects THEIR OWN QBO company at runtime
// from the Settings page, so the Replit QuickBooks connector (which binds one
// Repl-owner account) does not fit. Instead the install holds its own Intuit
// app credentials (QBO_CLIENT_ID / QBO_CLIENT_SECRET) and runs the full
// authorize-code flow itself, persisting per-company tokens in qbo_connections.
//
// The module is INERT until credentials are configured (mirrors Stripe being
// inert in desktop mode): isQboConfigured() is false, the Settings card shows a
// "not configured" state, and no network calls are attempted.
//
// We use direct Intuit REST calls via global fetch rather than the
// intuit-oauth / node-quickbooks libraries (both are loosely typed and add
// heavy deps); the task explicitly sanctions "direct Intuit REST calls".
// ---------------------------------------------------------------------------

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

const API_BASE_PRODUCTION = "https://quickbooks.api.intuit.com";
const API_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";

// QBO minor-version pin so response shapes stay stable.
const QBO_MINOR_VERSION = "70";

// Refresh the access token when it is within this window of expiring.
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

// Outbound calls to Intuit must time out rather than pin a request/worker.
const QBO_FETCH_TIMEOUT_MS = 20_000;

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  environment: "sandbox" | "production";
  redirectUri: string;
  apiBase: string;
}

export class QboNotConfiguredError extends Error {
  constructor() {
    super("QuickBooks Online is not configured on this install");
    this.name = "QboNotConfiguredError";
  }
}

export class QboNotConnectedError extends Error {
  constructor() {
    super("QuickBooks Online is not connected");
    this.name = "QboNotConnectedError";
  }
}

export class QboApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "QboApiError";
    this.status = status;
  }
}

// Derive the default OAuth redirect URI from the hosted public origin when one
// is not explicitly configured. Intuit requires this to exactly match a
// redirect URI registered on the Intuit app, so QBO_REDIRECT_URI takes
// precedence and should be set in production.
function defaultRedirectUri(): string | null {
  const explicit = process.env.QBO_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const origin =
    process.env.STOREFRONT_ORIGIN?.replace(/\/$/, "") ||
    (process.env.REPLIT_DOMAINS?.split(",")[0]?.trim()
      ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}`
      : null);
  if (!origin) return null;
  return `${origin}/api/integrations/qbo/callback`;
}

// Returns the resolved QBO config, or null when the install is not configured
// (no client id/secret, or no resolvable redirect URI). Inert-when-unset.
export function getQboConfig(): QboConfig | null {
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const redirectUri = defaultRedirectUri();
  if (!redirectUri) return null;
  const environment =
    process.env.QBO_ENVIRONMENT?.trim().toLowerCase() === "production"
      ? "production"
      : "sandbox";
  return {
    clientId,
    clientSecret,
    environment,
    redirectUri,
    apiBase:
      environment === "production" ? API_BASE_PRODUCTION : API_BASE_SANDBOX,
  };
}

export function isQboConfigured(): boolean {
  return getQboConfig() !== null;
}

// ---------------------------------------------------------------------------
// Token encryption at rest
//
// Access/refresh tokens are encrypted with AES-256-GCM using a key derived from
// the install's session secret, so a leaked DB dump does not expose live QBO
// credentials. Stored as "enc:<iv>:<tag>:<ciphertext>" (all base64). A value
// without the "enc:" prefix is treated as plaintext for forward-compatibility.
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = crypto
    .createHash("sha256")
    .update(`qbo-token:${resolveSessionSecret()}`)
    .digest();
  return cachedKey;
}

function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptToken(stored: string | null): string | null {
  if (!stored) return null;
  if (!stored.startsWith("enc:")) return stored;
  try {
    const [, ivB64, tagB64, dataB64] = stored.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch (err) {
    logger.error({ err }, "Failed to decrypt stored QBO token");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection row (single row id=1)
// ---------------------------------------------------------------------------

// Loads the single connection row, creating it the first time. The row exists
// even while disconnected so the account mapping survives.
export async function loadConnectionRow(): Promise<QboConnection> {
  const [existing] = await db.select().from(qboConnectionsTable).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(qboConnectionsTable)
    .values({ accountMapping: {} })
    .returning();
  return created;
}

export function isConnected(row: QboConnection): boolean {
  return !!row.realmId && !!row.refreshToken;
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
}

function basicAuthHeader(cfg: QboConfig): string {
  return (
    "Basic " +
    Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QBO_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// OAuth flow
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(cfg: QboConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: cfg.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(
  cfg: QboConfig,
  body: URLSearchParams,
): Promise<IntuitTokenResponse> {
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new QboApiError(res.status, `Token request failed: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as IntuitTokenResponse;
}

// Exchange an authorization code for tokens and persist a connected row.
export async function exchangeCodeAndStore(
  cfg: QboConfig,
  code: string,
  realmId: string,
): Promise<QboConnection> {
  const tokens = await postToken(
    cfg,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }),
  );
  const row = await loadConnectionRow();
  const companyName = await fetchCompanyName(cfg, realmId, tokens.access_token);
  const nowIso = new Date().toISOString();
  const [updated] = await db
    .update(qboConnectionsTable)
    .set({
      realmId,
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      tokenExpiresAt: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
      companyName,
      connectedAt: nowIso,
    })
    .where(eq(qboConnectionsTable.id, row.id))
    .returning();
  return updated;
}

// Returns a valid access token, refreshing (and persisting) when near expiry.
export async function getValidAccessToken(
  cfg: QboConfig,
  row: QboConnection,
): Promise<string> {
  if (!isConnected(row)) throw new QboNotConnectedError();
  const expiresAt = row.tokenExpiresAt
    ? new Date(row.tokenExpiresAt).getTime()
    : 0;
  const current = decryptToken(row.accessToken);
  if (current && expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return current;
  }
  const refresh = decryptToken(row.refreshToken);
  if (!refresh) throw new QboNotConnectedError();
  const tokens = await postToken(
    cfg,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  );
  await db
    .update(qboConnectionsTable)
    .set({
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      tokenExpiresAt: new Date(
        Date.now() + tokens.expires_in * 1000,
      ).toISOString(),
    })
    .where(eq(qboConnectionsTable.id, row.id));
  return tokens.access_token;
}

// Revoke the refresh token at Intuit and clear the stored credentials. The row
// (and its account mapping) is retained so a reconnect resumes cleanly.
export async function revokeAndClear(
  cfg: QboConfig,
  row: QboConnection,
): Promise<void> {
  const refresh = decryptToken(row.refreshToken);
  if (refresh) {
    try {
      await fetchWithTimeout(REVOKE_URL, {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(cfg),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ token: refresh }),
      });
    } catch (err) {
      // Best-effort: clearing local state must still proceed even if Intuit is
      // unreachable, so the owner is never stuck "connected".
      logger.warn({ err }, "QBO token revoke call failed; clearing locally");
    }
  }
  await db
    .update(qboConnectionsTable)
    .set({
      realmId: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      companyName: null,
      connectedAt: null,
    })
    .where(eq(qboConnectionsTable.id, row.id));
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

// Intuit throttles a company to ~500 requests/minute. A single mutex-chained
// minimum interval between outbound calls keeps the whole process (interactive
// pushes AND a full reconcile loop) comfortably under that budget without per
// call accounting. 130ms => ~460 req/min ceiling. Serializing through one promise
// chain also prevents a burst of concurrent fire-and-forget hooks from spiking.
const QBO_MIN_REQUEST_INTERVAL_MS = 130;
let qboThrottleChain: Promise<void> = Promise.resolve();

function throttleQbo(): Promise<void> {
  const wait = qboThrottleChain.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, QBO_MIN_REQUEST_INTERVAL_MS)),
  );
  // Swallow rejections so one failed slot cannot poison the shared chain.
  qboThrottleChain = wait.catch(() => undefined);
  return wait;
}

// Authenticated QBO API request. `path` is relative to the company endpoint,
// e.g. "invoice" or "query?query=...". Returns the parsed JSON body.
export async function qboApiRequest<T = unknown>(
  cfg: QboConfig,
  row: QboConnection,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!row.realmId) throw new QboNotConnectedError();
  await throttleQbo();
  const accessToken = await getValidAccessToken(cfg, row);
  const sep = path.includes("?") ? "&" : "?";
  const url = `${cfg.apiBase}/v3/company/${row.realmId}/${path}${sep}minorversion=${QBO_MINOR_VERSION}`;
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new QboApiError(
      res.status,
      `QBO ${method} ${path} failed (${res.status}): ${text.slice(0, 800)}`,
    );
  }
  return (await res.json()) as T;
}

// Runs a QBO SQL-like query and returns the named entity array.
export async function qboQuery<T = unknown>(
  cfg: QboConfig,
  row: QboConnection,
  entity: string,
  query: string,
): Promise<T[]> {
  const encoded = encodeURIComponent(query);
  const data = await qboApiRequest<{ QueryResponse?: Record<string, unknown> }>(
    cfg,
    row,
    "GET",
    `query?query=${encoded}`,
  );
  const arr = data.QueryResponse?.[entity];
  return Array.isArray(arr) ? (arr as T[]) : [];
}

async function fetchCompanyName(
  cfg: QboConfig,
  realmId: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const url = `${cfg.apiBase}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${QBO_MINOR_VERSION}`;
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      CompanyInfo?: { CompanyName?: string };
    };
    return data.CompanyInfo?.CompanyName ?? null;
  } catch {
    return null;
  }
}

// Persist a new account mapping (validated by the caller).
export async function saveAccountMapping(
  rowId: number,
  mapping: QboAccountMapping,
): Promise<QboAccountMapping> {
  const [updated] = await db
    .update(qboConnectionsTable)
    .set({ accountMapping: mapping })
    .where(eq(qboConnectionsTable.id, rowId))
    .returning();
  return updated.accountMapping;
}

export async function touchLastSync(rowId: number): Promise<string> {
  const nowIso = new Date().toISOString();
  await db
    .update(qboConnectionsTable)
    .set({ lastSyncAt: nowIso })
    .where(eq(qboConnectionsTable.id, rowId));
  return nowIso;
}
