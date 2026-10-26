// The app's tab lives in the URL hash (issue #37), so links, back/forward and refresh
// work without a router or a Pages _redirects rule: the server only ever sees /app/.
//   #offers (default) #lend #positions #admin
//   #offer/<id>  Offers tab with the take panel for that offer open
//   #repo/<id>   My positions, scrolled to that repo
// Pure functions only, so test/route.test.ts runs them under plain node.

export type Tab = "offers" | "lend" | "positions" | "admin";
export const TABS: readonly Tab[] = ["offers", "lend", "positions", "admin"];

export interface Route {
  tab: Tab;
  /** #offer/<id>: the offer whose take panel is open. */
  offer?: bigint;
  /** #repo/<id>: the position to scroll to. */
  repo?: bigint;
}

export const DEFAULT_ROUTE: Route = { tab: "offers" };

/**
 * Reads location.hash. `known` is false for a hash the app does not route
 * (it then falls back to Offers and the caller rewrites the URL to #offers).
 * An empty hash is the plain /app/ link: Offers, known, left as is.
 */
export function parseHash(hash: string): { route: Route; known: boolean } {
  const h = hash.replace(/^#\/?/, "").trim().toLowerCase();
  if (h === "") return { route: DEFAULT_ROUTE, known: true };
  if ((TABS as readonly string[]).includes(h)) return { route: { tab: h as Tab }, known: true };
  const m = /^(offer|repo)\/(\d{1,20})$/.exec(h);
  if (m) {
    const id = BigInt(m[2]);
    return { route: m[1] === "offer" ? { tab: "offers", offer: id } : { tab: "positions", repo: id }, known: true };
  }
  return { route: DEFAULT_ROUTE, known: false };
}

/** The canonical hash for a route; parseHash(toHash(r)) round-trips. */
export function toHash(r: Route): string {
  if (r.tab === "offers" && r.offer !== undefined) return `#offer/${r.offer}`;
  if (r.tab === "positions" && r.repo !== undefined) return `#repo/${r.repo}`;
  return `#${r.tab}`;
}

/** The tab actually shown: Admin only for the admin, everyone else sees Offers. */
export const shownTab = (r: Route, isAdmin: boolean): Tab => (r.tab === "admin" && !isAdmin ? "offers" : r.tab);

/** Tab a demo role lands on when picked. */
export const demoTab = (role: string): Tab =>
  role === "lender" ? "lend" : role === "admin" ? "admin" : role === "borrower" ? "offers" : "positions";
