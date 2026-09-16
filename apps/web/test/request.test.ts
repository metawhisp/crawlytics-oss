import { describe, expect, it } from "vitest";

import { failed, idle, refreshed, started, succeeded } from "../src/request.js";

// Every panel in this app used to write `.catch(() => setData(null))` by hand,
// and `data === null` also meant "the very first render, request still in
// flight". So a healthy backend showed "AI-боты не упирались в ошибки — отлично"
// while the request was still on the wire, and a rejected request showed the
// same sentence forever. Three outcomes were living in one value; this module
// is the layer that was missing between `api.ts` (which throws honestly) and
// the markup (which owns the words).

describe("idle", () => {
  it("starts as loading, not as a reassuring empty result", () => {
    const state = idle<string[]>();
    expect(state.status).toBe("loading");
    expect(state.data).toBeNull();
  });
});

describe("succeeded", () => {
  it("an empty answer is ready and empty — the calm 'no data' stays calm", () => {
    const state = succeeded(started(idle<string[]>(), 1), 1, []);
    expect(state.status).toBe("ready");
    expect(state.data).toEqual([]);
  });
});

describe("failed", () => {
  it("a refusal is an error, never a ready-and-empty result", () => {
    // This is the assertion the whole iteration exists for. If the module ever
    // collapses the two back together, this line is what goes red.
    const state = failed(started(idle<string[]>(), 1), 1, new Error("boom"));
    expect(state.status).toBe("error");
    expect(state.status).not.toBe("ready");
    expect(state.message).toContain("boom");
  });

  it("does not stutter the word Error into the sentence the panel prints", () => {
    // The panel renders "Не удалось загрузить данные: {message}", and
    // String(new Error(x)) is "Error: x", which read as "…данные: Error: …".
    const state = failed(started(idle<string[]>(), 1), 1, new Error("/api/v1/security -> 500"));
    expect(state.message).toBe("/api/v1/security -> 500");
  });

  it("still says something when what was thrown is not an Error", () => {
    const state = failed(started(idle<string[]>(), 1), 1, "plain string");
    expect(state.message).toBe("plain string");
  });

  it("a refusal shows nothing rather than the answer to an earlier question", () => {
    // Also a reversal. Keeping the last good data across a failure was written
    // for pollers — and the one poller in this app (Onboarding's 4s status
    // tick) is deliberately not on this module yet, so the only thing the
    // retention actually did was keep stale answers on screen under fresh
    // headings. When a poller is converted, it gets this back explicitly,
    // with a test of its own.
    const ready = succeeded(started(idle<string[]>(), 1), 1, ["/a"]);
    const state = failed(started(ready, 2), 2, new Error("offline"));
    expect(state.status).toBe("error");
    expect(state.data).toBeNull();
  });
});

describe("request numbers, not an alive flag", () => {
  // `let alive = true` in a useEffect teardown does not help under setInterval
  // (App.tsx:177, Onboarding.tsx:337): the teardown never runs between ticks,
  // so a slow earlier answer overwrites a newer one. Freshness is a number.
  it("the later request wins even when the earlier one resolves last", () => {
    const first = started(idle<string[]>(), 1);
    const second = started(first, 2);
    const afterSecond = succeeded(second, second.seq, ["new"]);
    const afterStaleFirst = succeeded(afterSecond, first.seq, ["old"]);
    expect(afterStaleFirst.data).toEqual(["new"]);
    expect(afterStaleFirst.status).toBe("ready");
  });

  it("a stale refusal cannot turn a fresh success into an error", () => {
    const first = started(idle<string[]>(), 1);
    const second = started(first, 2);
    const afterSecond = succeeded(second, second.seq, ["new"]);
    const afterStaleFailure = failed(afterSecond, first.seq, new Error("late"));
    expect(afterStaleFailure.status).toBe("ready");
    expect(afterStaleFailure.data).toEqual(["new"]);
  });

  it("a new request drops the previous answer — it answered a different question", () => {
    // This assertion is the reverse of the one it replaces, and the reversal is
    // the point. Carrying the old answer forward looked like a kindness
    // (no flash of "Загрузка…" when the period changes) and was a lie in every
    // panel keyed by a subject: picking a second bot rendered the FIRST bot's
    // timeseries, pages and sources under the second bot's headings, and a
    // refusal froze that mislabelled screen permanently. Step 5 of the wizard
    // did worse — it offered the previous policy's robots.txt, with a copy
    // button, under the toggles the operator had just changed.
    const ready = succeeded(started(idle<string[]>(), 1), 1, ["/a"]);
    const refreshing = started(ready, 2);
    expect(refreshing.status).toBe("loading");
    expect(refreshing.data).toBeNull();
  });
});

describe("a poll is the same question asked again", () => {
  // The distinction the module was missing. A new subject (another bot, another
  // period) must drop the old answer — that is `started`. A timer re-asking
  // about the SAME subject must not blank the panel every tick, and a single
  // refused tick must not erase what the operator is reading — that is
  // `refreshed`. Which one ran is also what tells `failed` whether there is
  // anything left worth keeping.
  it("keeps what is on screen while the same question is re-asked", () => {
    const ready = succeeded(started(idle<string[]>(), 1), 1, ["/a"]);
    const polling = refreshed(ready, 2);
    expect(polling.status).toBe("ready");
    expect(polling.data).toEqual(["/a"]);
  });

  it("one failed tick does not blank the panel", () => {
    const ready = succeeded(started(idle<string[]>(), 1), 1, ["/a"]);
    const state = failed(refreshed(ready, 2), 2, new Error("offline"));
    expect(state.status).toBe("error");
    expect(state.data).toEqual(["/a"]);
  });

  it("but a poll before the first answer is still just loading", () => {
    const polling = refreshed(idle<string[]>(), 2);
    expect(polling.status).toBe("loading");
    expect(polling.data).toBeNull();
  });

  it("and a changed subject still drops everything, even under a poll", () => {
    const ready = succeeded(started(idle<string[]>(), 1), 1, ["/a"]);
    const state = failed(started(ready, 2), 2, new Error("offline"));
    expect(state.status).toBe("error");
    expect(state.data).toBeNull();
  });
});
