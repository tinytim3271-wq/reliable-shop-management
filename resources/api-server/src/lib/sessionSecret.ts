import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { runtimeConfig } from "@workspace/db";
import { logger } from "./logger";

/**
 * Resolve the express-session signing secret for the active runtime.
 *
 * Hosted (default / tests / published storefront): SESSION_SECRET MUST be
 * provided via the environment, exactly as before. A missing secret is a hard
 * startup error so a cloud deployment never silently runs with an ephemeral key
 * that would invalidate every session on restart.
 *
 * Desktop (installed Windows hub): there is no operator to set an env var, so a
 * high-entropy secret is generated once and persisted under the user-data
 * directory (runtimeConfig.sessionSecretFile). It is reused on every subsequent
 * boot so logged-in sessions survive hub restarts. An explicit SESSION_SECRET
 * still wins if one is set.
 */
export function resolveSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;

  if (!runtimeConfig.isDesktop) {
    throw new Error("SESSION_SECRET environment variable is required");
  }

  const file = runtimeConfig.sessionSecretFile;
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable file — fall through and generate a fresh secret.
  }

  const secret = randomBytes(48).toString("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  // 0o600: readable only by the owner. Ignored on Windows ACLs but harmless.
  writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
  logger.info({ file }, "Generated and persisted a new desktop session secret");
  return secret;
}
