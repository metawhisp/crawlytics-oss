import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * Offline license verification. A license key is `<payloadB64url>.<sigB64url>`
 * where the signature is an ed25519 signature (our private key) over the
 * payload-b64url string. The server only needs our public key to verify, so a
 * paid instance never has to phone home. The dashboard gate (variant B) is
 * driven by whether this returns a valid license.
 */

export interface LicensePayload {
  /** Tier id, e.g. "ltd". */
  tier: string;
  /** Holder identifier (email/id). */
  sub?: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds; omitted = perpetual. */
  exp?: number;
}

export interface LicenseInfo {
  valid: boolean;
  tier?: string;
  holder?: string;
  issuedAt?: string;
  expiresAt?: string;
  reason?: string;
}

function toPublicKey(publicKey: KeyObject | string): KeyObject {
  return typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
}

function toPrivateKey(privateKey: KeyObject | string): KeyObject {
  return typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
}

/**
 * Sign a license payload with our private key, producing a key that
 * {@link verifyLicenseKey} accepts. Runs ONLY in the issuer service (which
 * holds the private key) — never in a distributed instance.
 */
export function signLicense(payload: LicensePayload, privateKey: KeyObject | string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(payloadB64), toPrivateKey(privateKey));
  return `${payloadB64}.${signature.toString("base64url")}`;
}

/** ISO string for a unix-seconds timestamp, or null if it is out of Date range. */
function safeIso(seconds: number): string | null {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Verify an ed25519-signed license key against our public key (PEM or KeyObject). */
export function verifyLicenseKey(key: string, publicKey: KeyObject | string): LicenseInfo {
  const parts = key.trim().split(".");
  const payloadB64 = parts[0];
  const sigB64 = parts[1];
  if (
    parts.length !== 2 ||
    payloadB64 === undefined ||
    payloadB64.length === 0 ||
    sigB64 === undefined ||
    sigB64.length === 0
  ) {
    return { valid: false, reason: "malformed license key" };
  }

  let signatureOk = false;
  try {
    signatureOk = verify(null, Buffer.from(payloadB64), toPublicKey(publicKey), Buffer.from(sigB64, "base64url"));
  } catch {
    return { valid: false, reason: "license signature check failed" };
  }
  if (!signatureOk) {
    return { valid: false, reason: "invalid license signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "unreadable license payload" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { valid: false, reason: "invalid license payload" };
  }

  const record = parsed as Record<string, unknown>;
  const tier = record["tier"];
  const iat = record["iat"];
  const sub = record["sub"];
  const exp = record["exp"];
  if (
    typeof tier !== "string" ||
    typeof iat !== "number" ||
    !Number.isFinite(iat) ||
    (sub !== undefined && typeof sub !== "string") ||
    (exp !== undefined && (typeof exp !== "number" || !Number.isFinite(exp)))
  ) {
    return { valid: false, reason: "invalid license payload" };
  }

  const issuedAt = safeIso(iat);
  if (issuedAt === null) {
    return { valid: false, reason: "invalid license payload" };
  }
  let expiresAt: string | undefined;
  if (exp !== undefined) {
    const iso = safeIso(exp);
    if (iso === null) {
      return { valid: false, reason: "invalid license payload" };
    }
    expiresAt = iso;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (exp !== undefined && nowSec >= exp) {
    return {
      valid: false,
      reason: "license expired",
      tier,
      ...(sub !== undefined ? { holder: sub } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {})
    };
  }

  return {
    valid: true,
    tier,
    ...(sub !== undefined ? { holder: sub } : {}),
    issuedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {})
  };
}

/**
 * Our license-signing public key (SPKI PEM). The matching private key lives
 * only in our secret store; the issuer signs licenses with it. The trust
 * anchor is THIS constant (or an explicit arg for tests) — never an env value
 * — so a self-host cannot supply its own public key. (Residual I-6 hardening:
 * strip the dev dashboard override in the production build.)
 */
const PRODUCTION_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5QbFHbqkT+1iqfCfqrsFhBQt4wUX/Zp7JEskTdLukgA=
-----END PUBLIC KEY-----
`;

/**
 * Verify a license key against the trusted public key (baked constant by
 * default). This is the single trust anchor for keys submitted at runtime —
 * e.g. the dashboard `POST /api/license` route passes a UI-entered key here —
 * so the anchor is never an env or request value.
 */
export function verifyTrustedLicense(
  key: string,
  trustedPublicKey: string = PRODUCTION_LICENSE_PUBLIC_KEY
): LicenseInfo {
  if (trustedPublicKey.length === 0) {
    return { valid: false, reason: "no trusted license public key" };
  }
  return verifyLicenseKey(key, trustedPublicKey);
}

/**
 * Load + verify the license from `CRAWLYTICS_LICENSE_KEY` against the trusted
 * public key (baked constant by default). Returns an invalid LicenseInfo (with
 * a reason) when unconfigured — i.e. headless.
 */
export function loadLicense(
  env: NodeJS.ProcessEnv = process.env,
  trustedPublicKey: string = PRODUCTION_LICENSE_PUBLIC_KEY
): LicenseInfo {
  const key = env["CRAWLYTICS_LICENSE_KEY"];
  if (key === undefined || key.length === 0) {
    return { valid: false, reason: "no license configured" };
  }
  return verifyTrustedLicense(key, trustedPublicKey);
}
