import { useState } from "react";
import type { AssetConfig, FeedReading, Nav, ProtocolConfig } from "../chain";
import { LIVE_FEED, type Token } from "../config";
import { fmtNav } from "../format";
import { assetLabel } from "../sep40";
import { Live, Skel, TxHash, useFlash } from "../ui";

const fmtAge = (s: number) => {
  const a = Math.max(0, s);
  if (a < 60) return `${a} s ago`;
  if (a < 3600) return `${Math.floor(a / 60)} min ${a % 60} s ago`;
  return `${Math.floor(a / 3600)} h ${Math.floor((a % 3600) / 60)} min ago`;
};

/** Bell in the header: demo notices live in a popover, not a banner in the page. The dot clears once opened. */
export function DemoInfo({ config, asset }: { config: ProtocolConfig; asset: AssetConfig }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  const daySecs = Number(config.day_secs);
  const dayWord = daySecs === 60 ? "1 minute" : `${daySecs} seconds`;
  const maxAgeMin = Number(asset.max_nav_age_secs) / 60;
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

export function NavStatus({
  token,
  nav,
  now,
  stale,
  loaded,
}: {
  token: Token;
  nav: Nav | null;
  now: number;
  stale: boolean;
  loaded: boolean;
}) {
  const age = nav ? now - Number(nav.timestamp) : null;
  const navRef = useFlash(nav ? String(nav.price) : null, navDir);
  return (
    <div className="app-status__group" aria-label={`${token.code} NAV`} aria-busy={loaded ? undefined : "true"}>
      <span className="app-status__label">{token.code} NAV</span>
      {!loaded ? (
        <Skel w={90} h={14} />
      ) : (
        <>
          <span className="app-status__nav app-flashable" data-testid={token.kind === "sac" ? "nav" : `nav-${token.code}`} ref={navRef}>
            {nav ? fmtNav(nav.price, nav.decimals) : "—"}
          </span>
          {nav ? (
            stale ? (
              <Live state="stale" word="Delayed" meta="new loans paused" />
            ) : (
              <Live state="on" word="Live" meta="fresh NAV" />
            )
          ) : (
            <Live state="off" word="No price" meta="push one from Admin" />
          )}
          {age !== null && <span className="cv-field__hint">{fmtAge(age)}</span>}
        </>
      )}
    </div>
  );
}

/**
 * The live SEP-40 feed (config LIVE_FEED), next to the mock NAV for comparison.
 * The contract prices collateral off the mock only. On a failed read it says so;
 * it never shows a blank or a stand-in number.
 */
export function LiveFeedStatus({ live, now }: { live: FeedReading | null | Error | undefined; now: number }) {
  const reading = live && !(live instanceof Error) ? live : null;
  const navRef = useFlash(reading ? String(reading.price) : null, navDir);
  const asset = LIVE_FEED ? assetLabel(LIVE_FEED.asset) : "";
  return (
    <div className="app-status__group" aria-label="Live feed, reference only, not used by the contract" aria-busy={live === undefined ? "true" : undefined}>
      <span className="app-status__label">Live feed{asset && ` ${asset}`}</span>
      {live === undefined ? (
        <Skel w={90} h={14} />
      ) : reading ? (
        <>
          <span className="app-status__nav app-flashable" data-testid="live-feed" ref={navRef}>
            {fmtNav(reading.price, reading.decimals)}
          </span>
          <span className="cv-field__hint">{fmtAge(now - reading.timestamp)}</span>
        </>
      ) : (
        <span title={live instanceof Error ? live.message : "The feed has no price for this asset"}>
          <Live state="off" word="Live feed unavailable" />
        </span>
      )}
      <span className="cv-field__hint">(reference only, not used by the contract)</span>
      {LIVE_FEED && <TxHash kind="CONTRACT" value={LIVE_FEED.oracle} />}
    </div>
  );
}
