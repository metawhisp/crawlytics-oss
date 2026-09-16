import { afterAll, describe, expect, it } from "vitest";

import { evaluateRules } from "../src/alerts/rules.js";
import { IT_SITE } from "./fixture.js";
import { clickHouseReady, testClient } from "./harness.js";

/**
 * Alerts wake a person up, so a forged bot must never be the reason. The fixture
 * carries 30 spoofed ai_fetcher hits from the last two minutes — a burst that
 * trips every threshold if anything counts it as AI traffic.
 */

const client = clickHouseReady() ? testClient() : null;

afterAll(async () => {
  await client?.close();
});

const ALL_RULES = { spike: true, newBot: false, spoof: true, brokenCitation: true };
const WITH_NEW_BOT = { spike: false, newBot: true, spoof: false, brokenCitation: false };

describe.skipIf(!clickHouseReady())("alert rules", () => {
  it("a forged burst never raises an AI traffic spike", async () => {
    if (!client) {
      throw new Error("ClickHouse is not available");
    }
    const events = await evaluateRules(client, IT_SITE, {
      rules: ALL_RULES,
      spikeFactor: 3,
      windowMinutes: 60
    });
    expect(events.filter((event) => event.rule === "spike")).toEqual([]);
  });

  it("still reports the forgery itself — it is the point of that rule", async () => {
    if (!client) {
      throw new Error("ClickHouse is not available");
    }
    const events = await evaluateRules(client, IT_SITE, {
      rules: ALL_RULES,
      spikeFactor: 3,
      windowMinutes: 60
    });
    const spoof = events.filter((event) => event.rule === "spoof");
    expect(spoof.length).toBeGreaterThan(0);
  });

  it("a forged bot erroring on a healthy page never raises a broken-citation alert", async () => {
    if (!client) {
      throw new Error("ClickHouse is not available");
    }
    const events = await evaluateRules(client, IT_SITE, {
      rules: ALL_RULES,
      spikeFactor: 3,
      windowMinutes: 60
    });
    const broken = events
      .filter((event) => event.rule === "broken_citation")
      .map((event) => event.subject);
    // /blog/alpha served verified AI bots fine for weeks, so it DOES qualify as
    // "previously cited". The only errors on it now come from a forgery, and
    // that must not be enough to page anyone.
    expect(broken).not.toContain("/blog/alpha");
  });

  it("a page whose only past success was forged is not a broken citation", async () => {
    if (!client) {
      throw new Error("ClickHouse is not available");
    }
    const events = await evaluateRules(client, IT_SITE, {
      rules: ALL_RULES,
      spikeFactor: 3,
      windowMinutes: 60
    });
    const broken = events.filter((event) => event.rule === "broken_citation").map((event) => event.subject);
    // /blog/phantom: three forged 200s in its history, two real 404s now. The
    // errors are real, but nothing real ever retrieved this page successfully,
    // so there is no citation to have broken.
    expect(broken).not.toContain("/blog/phantom");
    // Crawled for training and never retrieved to answer anyone: a 404 here is
    // not a broken citation either.
    expect(broken).not.toContain("/blog/train-only");
    // A page retrieval bots still fetch fine, whose only errors are a training
    // crawler meeting the 403 the owner deliberately set. Blocking training bots
    // is what this product recommends; it must not then wake the owner up.
    expect(broken).not.toContain("/guide/blocked");
    // The same deliberate block, met by a retrieval bot this time: the
    // actor_type filter cannot see it, so without a status filter the alert
    // pages the owner about a door they closed themselves.
    expect(broken).not.toContain("/guide/fetch-blocked");
    // ...and the rule still does its job. Without this the lines above are
    // satisfied by a rule that never fires at all.
    expect(broken).toContain("/docs/api");
  });

  it("'new bot' means a new real bot, not a new disguise", async () => {
    if (!client) {
      throw new Error("ClickHouse is not available");
    }
    const events = await evaluateRules(client, IT_SITE, {
      rules: WITH_NEW_BOT,
      spikeFactor: 3,
      windowMinutes: 60
    });
    const subjects = events.filter((event) => event.rule === "new_bot").map((event) => event.subject);
    // Both identities are new to this site and both arrived in the window. Only
    // the real one is news; the forgery already has its own rule.
    expect(subjects).not.toContain("meta-externalagent");
    expect(subjects).toContain("applebot-extended");
  });
});
