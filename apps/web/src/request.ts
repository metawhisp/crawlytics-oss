/** The layer between `api.ts`, which throws honestly, and the markup, which owns
 * the words. Before this module every panel wrote `.catch(() => setData(null))`
 * by hand, and `null` also meant "first render, request still in flight" — so
 * three different outcomes shared one value and the calm empty-state sentence
 * ("AI bots hit no errors — nothing to fix") was shown for all three.
 *
 * Freshness is a request NUMBER, not a `let alive = true` teardown flag. Under
 * `setInterval` (App.tsx, Onboarding.tsx) the teardown does not run between
 * ticks, so a slow earlier answer could overwrite a newer one. */

import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

/** A union, not a record with a status field: `ready` is the only variant that
 * carries data, so every call site gets that for free from the type checker
 * instead of re-deriving it with a null check of its own.
 *
 * `data` on the other two is always null: a request that is in flight or was
 * refused has no answer, and the answer to the PREVIOUS request is not an
 * answer to this one. `seq` is the request this state reflects; answers
 * carrying anything else are stale. */
export type RequestState<T> =
  | { readonly status: "loading"; readonly data: T | null; readonly message: null; readonly seq: number }
  | { readonly status: "error"; readonly data: T | null; readonly message: string; readonly seq: number }
  | { readonly status: "ready"; readonly data: T; readonly message: null; readonly seq: number };

export function idle<T>(): RequestState<T> {
  return { status: "loading", data: null, message: null, seq: 0 };
}

/** Begin request `seq`. The previous answer goes with it.
 *
 * Carrying it forward is tempting — no flash of "Loading…" when the operator
 * switches period — and it is wrong wherever the request is keyed by a
 * subject. A panel asked about bot A and then about bot B would render A's
 * timeseries, pages and sources under B's headings for the whole flight, and
 * under a refusal, permanently. The wizard's step 5 offered the previous
 * policy's robots.txt, copy button and all, under the toggles that had just
 * been changed. A request in flight has no answer yet; saying so is the job. */
export function started<T>(previous: RequestState<T>, seq: number): RequestState<T> {
  // `previous` is taken and deliberately not read: the discarding is the
  // decision, and a signature that could not see the old answer would make it
  // untestable.
  return { status: "loading", data: null, message: null, seq };
}

/** Begin request `seq` as a re-ask of the SAME question — a timer tick, not a
 * new subject. What is on screen stays on screen: it is still the latest true
 * answer to the question being asked, so blanking the panel every tick would be
 * a lie in the other direction. This is also what lets `failed` tell a refused
 * poll (keep showing the last answer) from a refused new question (show
 * nothing): after `started` there is nothing left to keep. */
export function refreshed<T>(state: RequestState<T>, seq: number): RequestState<T> {
  if (state.status === "ready") {
    return { status: "ready", data: state.data, message: null, seq };
  }
  return { status: "loading", data: state.data, message: null, seq };
}

export function succeeded<T>(state: RequestState<T>, seq: number, data: T): RequestState<T> {
  if (seq !== state.seq) {
    return state;
  }
  return { status: "ready", data, message: null, seq };
}

/** What the panel shows after "Could not load data: ". `String(err)` on
 * an Error prefixes "Error: ", which reads as "…data: Error: /api/… -> 500". */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function failed<T>(state: RequestState<T>, seq: number, cause: unknown): RequestState<T> {
  if (seq !== state.seq) {
    return state;
  }
  // Whatever survived the start of this request: nothing after `started`, the
  // last good answer after `refreshed`.
  return { status: "error", data: state.data, message: describe(cause), seq };
}

/** Runs `run` whenever `deps` change and reports which of the three things is
 * true. With `pollMs`, it also re-asks on a timer — and a tick is a re-ask of
 * the same question, so it keeps what is on screen rather than blanking it.
 *
 * The counter lives in a ref, not in state: a state update is not applied until
 * the next render, which is not guaranteed to happen before the promise
 * settles, and the number has to be known when the answer comes back. `run`
 * lives in a ref too — it is rebuilt every render, so a timer that closed over
 * it would keep calling last minute's version. */
export function useRequest<T>(run: () => Promise<T>, deps: DependencyList, pollMs?: number): RequestState<T> {
  const [state, setState] = useState<RequestState<T>>(idle<T>);
  const seqRef = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;

  const fire = useCallback((begin: (previous: RequestState<T>, seq: number) => RequestState<T>) => {
    const seq = (seqRef.current += 1);
    setState((previous) => begin(previous, seq));
    runRef.current().then(
      (data) => {
        setState((previous) => succeeded(previous, seq, data));
      },
      (cause: unknown) => {
        setState((previous) => failed(previous, seq, cause));
      }
    );
  }, []);

  useEffect(() => {
    fire(started);
    // The caller owns the dependency list; `run` is rebuilt every render by
    // design and must not be one of them.
  }, deps);

  useEffect(() => {
    if (pollMs === undefined) {
      return undefined;
    }
    const timer = setInterval(() => {
      fire(refreshed);
    }, pollMs);
    return () => {
      clearInterval(timer);
    };
  }, [fire, pollMs]);

  return state;
}
