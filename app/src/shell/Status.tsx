import { useState } from "react";
import { LIVE_FEED, type Token } from "../config";
import type { AssetConfig, FeedReading, Nav, ProtocolConfig } from "../chain";
import { fmtNav } from "../format";
import { Live, Skel, Tip, TxHash, useFlash } from "../ui";
import { assetLabel } from "../sep40";
import { navBadge, type NavHealth } from "../gates";

/** "48 s ago", then whole minutes / hours: a seconds counter beside a minutes-old price is noise. */
const fmtAge = (s: number) => {
  const a = Math.max(0, s);
  if (a < 60) return `${a} s ago`;
  if (a < 3600) return `${Math.floor(a / 60)} min ago`;
  return `${Math.floor(a / 3600)} h ${Math.floor((a % 3600) / 60)} min ago`;
};

// The bell's dot marks a notice not opened yet; opening it is remembered across reloads (F13).
// The key carries the notice's figures, so a changed notice shows its dot again.
const SEEN_KEY = "caravel:notice-seen";
const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};

/** Bell in the header: demo notices live in a popover, not a banner in the page. The dot clears once opened. */
export function DemoInfo({ config, asset }: { config: ProtocolConfig; asset: AssetConfig }) {
  const [open, setOpen] = useState(false);
  const daySecs = Number(config.day_secs);
  const dayWord = daySecs === 60 ? "1 minute" : `${daySecs} seconds`;
  const maxAgeMin = Number(asset.max_nav_age_secs) / 60;
  const version = `${daySecs}/${maxAgeMin}`;
  const [seen, setSeen] = useState(() => readSeen() === version);
  return (
    <div className="app-notify">
      <button
        type="button"
        className="app-bell"
        aria-label={seen ? "Notifications" : "Notifications, 1 new"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setSeen(true);
          try {
            localStorage.setItem(SEEN_KEY, version);
          } catch {
            /* private mode: the dot just comes back next load */
          }
        }}
      >
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
          <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
          <path d="M10 20.5h4" />
        </svg>
        {!seen && <span className="app-bell__dot" />}
      </button>
      {open && (
        <div className="app-pop" role="dialog" aria-label="Notifications">
          <div className="app-pop__head">
            <span>Notifications</span>
            <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className="app-pop__item">
            <span className="app-pop__icon" aria-hidden="true">i</span>
            <span>
              <b>Demo time</b>1 day lasts {dayWord} here, so a 7-day loan ends in {daySecs === 60 ? "7 minutes" : `${7 * daySecs} seconds`}. New
              loans need a price updated in the last {maxAgeMin} minutes.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const navDir = (a: string, b: string) => (BigInt(b) > BigInt(a) ? "up" : BigInt(b) < BigInt(a) ? "down" : undefined);

/** One collateral's NAV in the footer: price, then "Live · 48 s ago" or why the contract holds it. */
export function NavStatus({
  token,
  nav,
  health,
  hold,
  loaded,
  failed,
}: {
  token: Token;
  nav: Nav | null;
  health: NavHealth;
  /** Why the contract holds this price (band / future timestamp), shown on hover. */
  hold: string | null;
  loaded: boolean;
  /** The read failed before anything loaded: say so instead of a skeleton that never resolves. */
  failed?: boolean;
}) {
  const age = health.age;
  const badge = navBadge(health);
  const navRef = useFlash(nav ? String(nav.price) : null, navDir);
  const ageText = age !== null ? fmtAge(age) : null;
  return (
    <div
      className="app-status__group"
      aria-label={`${token.code} NAV`}
      aria-busy={loaded || failed ? undefined : "true"}
      title={hold ?? undefined}
      data-nav-state={loaded ? health.state : undefined}
    >
      <span className="app-status__label">{token.code} NAV</span>
      {!loaded ? (
        failed ? (
          <Live state="off" word="Not read" />
        ) : (
          <Skel w={90} h={14} />
        )
      ) : (
        <>
          <span className="app-status__nav app-flashable" data-testid={token.kind === "sac" ? "nav" : `nav-${token.code}`} ref={navRef}>
            {nav ? fmtNav(nav.price, nav.decimals) : "—"}
          </span>
          <Live state={badge.state} word={badge.word} meta={badge.meta || undefined} />
          {ageText && <span className="app-status__age">· {ageText}</span>}
        </>
      )}
    </div>
  );
}

/**
 * The live SEP-40 feed (config LIVE_FEED), next to the mock NAV for comparison:
 * "USDC ref 1.0013 · 4 min ago". The contract prices collateral off the mock only,
 * which the tip says. On a failed read it says so; it never shows a stand-in number.
 */
export function LiveFeedStatus({ live, now }: { live: FeedReading | null | Error | undefined; now: number }) {
  const reading = live && !(live instanceof Error) ? live : null;
  const navRef = useFlash(reading ? String(reading.price) : null, navDir);
  const asset = LIVE_FEED ? assetLabel(LIVE_FEED.asset) : "";
  return (
    <div
      className="app-status__group"
      aria-label={`${asset || "Live feed"} reference price, not used by the contract`}
      aria-busy={live === undefined ? "true" : undefined}
    >
      <span className="app-status__label">{asset ? `${asset} ref` : "Live feed"}</span>
      {live === undefined ? (
        <Skel w={90} h={14} />
      ) : reading ? (
        <>
          <span className="app-status__nav app-flashable" data-testid="live-feed" ref={navRef}>
            {fmtNav(reading.price, reading.decimals)}
          </span>
          <span className="app-status__age">· {fmtAge(now - reading.timestamp)}</span>
        </>
      ) : (
        <span title={live instanceof Error ? live.message : "The feed has no price for this asset"}>
          <Live state="off" word="Feed unavailable" />
        </span>
      )}
      <Tip>
        Reference only: a live SEP-40 price feed, shown for comparison. The contract does not use it; it prices collateral from the
        Caravel oracle.
        {LIVE_FEED && (
          <>
            {" "}
            <TxHash kind="CONTRACT" tag="Feed" value={LIVE_FEED.oracle} />
          </>
        )}
      </Tip>
    </div>
  );
}
