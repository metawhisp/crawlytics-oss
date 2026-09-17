import type { RequestState } from "./request.js";

/**
 * The three outcomes a panel can be in, said out loud. Panels used to render
 * their calm empty-state sentence for all three, so "AI bots hit no errors —
 * nothing to fix" appeared while the request was still in flight and again
 * after it was refused.
 *
 * `empty` stays with the caller: each panel knows what "nothing to show" means
 * in its own words.
 */
export function Placeholder<T>({ state, empty }: { state: RequestState<T>; empty: string }) {
  if (state.status === "loading") {
    return <div className="empty">Loading…</div>;
  }
  if (state.status === "error") {
    return <div className="err">Could not load data: {state.message}</div>;
  }
  return <div className="empty">{empty}</div>;
}
