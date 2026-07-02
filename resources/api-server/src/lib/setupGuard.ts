import crypto from "node:crypto";
import { runtimeConfig } from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// First-run setup protection
//
// The very first /auth/setup call creates the owner (admin) account. The
// default posture depends on the runtime:
//
//   hosted (default, internet-facing):
//     - unset / empty   -> "auto": the server mints a random one-time setup
//                          code at startup and logs it; the operator must enter
//                          it on the first screen. This closes the public-
//                          internet takeover window without any configuration.
//     - "auto"          -> same as above (explicit opt-in for clarity).
//     - "off"           -> disables protection (use only on private networks).
//     - any other value -> that exact string is the required setup code.
//
//   desktop (local LAN install):
//     - unset / empty   -> "off": setup is open (no friction; never bricked).
//     - "auto"          -> the server mints a random one-time code and logs it.
//     - any other value -> that exact string is the required setup code.
//
// The comparison is constant-time so a configured secret cannot be guessed by
// timing.
// ---------------------------------------------------------------------------

export type SetupProtectionMode = "off" | "auto" | "secret";

function configuredSecret(): string | undefined {
  const v = process.env["SETUP_SECRET"]?.trim();
  return v && v.length > 0 ? v : undefined;
}

export function setupProtectionMode(): SetupProtectionMode {
  const v = configuredSecret();
  if (!v) {
    // Hosted deployments default to "auto" so a fresh internet-facing instance
    // is never left open. Desktop (LAN-only) stays fail-open.
    return runtimeConfig.isHosted ? "auto" : "off";
  }
  if (v.toLowerCase() === "auto") return "auto";
  if (v.toLowerCase() === "off") return "off";
  return "secret";
}

// Lazily-generated one-time code for "auto" mode. Held in memory for the life of
// the process, so it stays stable across the first screen's submit but is gone
// on restart (and irrelevant once setup is complete).
let autoSetupCode: string | null = null;

export function getAutoSetupCode(): string | null {
  if (setupProtectionMode() !== "auto") return null;
  if (!autoSetupCode) {
    // base32-ish, uppercase, no ambiguous chars; grouped for readability.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const group = () =>
      Array.from(
        { length: 4 },
        () => alphabet[crypto.randomInt(alphabet.length)],
      ).join("");
    autoSetupCode = `${group()}-${group()}-${group()}`;
  }
  return autoSetupCode;
}

// The code the caller must present, or null when setup is open (fail-open).
export function requiredSetupCode(): string | null {
  const mode = setupProtectionMode();
  if (mode === "off") return null;
  if (mode === "auto") return getAutoSetupCode();
  return configuredSecret() ?? null;
}

// Whether first-run setup currently requires a setup code (used by the client to
// decide whether to show the setup-code field on the first screen).
export function isSetupProtected(): boolean {
  return requiredSetupCode() !== null;
}

// Constant-time check of the submitted code. Returns true (allow) when setup is
// open. A length mismatch returns false without a timing-equal compare; this
// only reveals the code's length, which is acceptable.
export function setupCodeMatches(candidate: string | undefined): boolean {
  const required = requiredSetupCode();
  if (!required) return true; // fail open — no protection configured
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(required);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Logs the first-run security posture once at startup, but only while setup is
// still pending (no users yet). Keeps local installs friction-free while making
// the exposure — and how to close it — obvious for public deployments.
export function logFirstRunPosture(needsSetup: boolean): void {
  if (!needsSetup) return;
  const mode = setupProtectionMode();
  if (mode === "auto") {
    const code = getAutoSetupCode();
    logger.warn(
      "First-run setup is PROTECTED. Enter this one-time setup code on the " +
        `first screen to create the owner account: ${code}`,
    );
    return;
  }
  if (mode === "secret") {
    logger.warn(
      "First-run setup is PROTECTED by the configured SETUP_SECRET. The owner " +
        "must enter it on the first screen to create the account.",
    );
    return;
  }
  logger.warn(
    "First-run setup is OPEN: the first visitor can create the owner account. " +
      "This is fine for a desktop/LAN install. To require a one-time setup code, " +
      "set SETUP_SECRET=auto (prints code to logs) or SETUP_SECRET=<your-code>.",
  );
}
