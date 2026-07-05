import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadLicense, signLicense, verifyLicenseKey } from "../src/license.js";

function makeKey(payload: unknown, privateKey: KeyObject): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(null, Buffer.from(payloadB64), privateKey);
  return `${payloadB64}.${sig.toString("base64url")}`;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

describe("verifyLicenseKey", () => {
  it("accepts a valid signed license", () => {
    const key = makeKey({ tier: "ltd", sub: "a@b.com", iat: 1700000000 }, privateKey);
    const info = verifyLicenseKey(key, pubPem);
    expect(info.valid).toBe(true);
    expect(info.tier).toBe("ltd");
    expect(info.holder).toBe("a@b.com");
  });

  it("accepts a license with no expiry (perpetual)", () => {
    const key = makeKey({ tier: "ltd", iat: 1700000000 }, privateKey);
    expect(verifyLicenseKey(key, pubPem).valid).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const key = makeKey({ tier: "ltd", iat: 1700000000 }, privateKey);
    const sig = key.split(".")[1] ?? "";
    const tamperedPayload = Buffer.from(JSON.stringify({ tier: "enterprise", iat: 1700000000 })).toString("base64url");
    expect(verifyLicenseKey(`${tamperedPayload}.${sig}`, pubPem).valid).toBe(false);
  });

  it("rejects an expired license", () => {
    const key = makeKey({ tier: "ltd", iat: 1700000000, exp: 1700000001 }, privateKey);
    const info = verifyLicenseKey(key, pubPem);
    expect(info.valid).toBe(false);
    expect(info.reason).toMatch(/expired/u);
  });

  it("rejects malformed keys", () => {
    expect(verifyLicenseKey("garbage", pubPem).valid).toBe(false);
    expect(verifyLicenseKey("only-one-part", pubPem).valid).toBe(false);
  });

  it("rejects a license signed by a different key", () => {
    const other = generateKeyPairSync("ed25519");
    const key = makeKey({ tier: "ltd", iat: 1700000000 }, other.privateKey);
    expect(verifyLicenseKey(key, pubPem).valid).toBe(false);
  });

  it("rejects a validly-signed payload with a non-numeric expiry", () => {
    const key = makeKey({ tier: "ltd", iat: 1700000000, exp: "soon" }, privateKey);
    expect(verifyLicenseKey(key, pubPem).valid).toBe(false);
  });

  it("rejects signed null and out-of-range timestamps without throwing", () => {
    expect(verifyLicenseKey(makeKey(null, privateKey), pubPem).valid).toBe(false);
    expect(verifyLicenseKey(makeKey({ tier: "ltd", iat: 1700000000, exp: 1e20 }, privateKey), pubPem).valid).toBe(false);
    expect(verifyLicenseKey(makeKey({ tier: "ltd", iat: 1e20 }, privateKey), pubPem).valid).toBe(false);
  });
});

describe("signLicense", () => {
  it("produces a key that verifies against the matching public key (round-trip)", () => {
    const key = signLicense({ tier: "ltd", sub: "buyer@x.com", iat: 1700000000 }, privateKey);
    const info = verifyLicenseKey(key, pubPem);
    expect(info.valid).toBe(true);
    expect(info.tier).toBe("ltd");
    expect(info.holder).toBe("buyer@x.com");
  });

  it("does not verify against a different public key", () => {
    const other = generateKeyPairSync("ed25519");
    const key = signLicense({ tier: "ltd", iat: 1700000000 }, privateKey);
    const otherPub = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyLicenseKey(key, otherPub).valid).toBe(false);
  });
});

describe("loadLicense", () => {
  it("is invalid when unconfigured (headless)", () => {
    expect(loadLicense({}).valid).toBe(false);
    expect(loadLicense({ CRAWLYTICS_LICENSE_KEY: "x" }).valid).toBe(false);
  });

  it("ignores any env-supplied public key — only the trusted key is honoured", () => {
    const key = makeKey({ tier: "ltd", iat: 1700000000 }, privateKey);
    // a matching pubkey in env must NOT be trusted (baked key is empty here)
    expect(loadLicense({ CRAWLYTICS_LICENSE_KEY: key, CRAWLYTICS_LICENSE_PUBKEY: pubPem }).valid).toBe(false);
  });

  it("verifies against the trusted public key", () => {
    const key = makeKey({ tier: "ltd", iat: 1700000000 }, privateKey);
    const info = loadLicense({ CRAWLYTICS_LICENSE_KEY: key }, pubPem);
    expect(info.valid).toBe(true);
    expect(info.tier).toBe("ltd");
  });
});
