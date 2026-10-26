// Thin React wrappers over the design system markup (design/components/*/preview.html).
import { useEffect, useRef, type ReactNode } from "react";
import { EXPLORER } from "./config";
import type { Status } from "./chain";
import { short } from "./format";

type HashKind = "TX" | "CONTRACT" | "ACCOUNT";
const explorerPath: Record<HashKind, string> = { TX: "tx", CONTRACT: "contract", ACCOUNT: "account" };

/** `tag` replaces the kind word in the chip ("Oracle" instead of "CONTRACT"), so a label never sits beside a second one. */
export function TxHash({ kind, value, link = true, tag }: { kind: HashKind; value: string; link?: boolean; tag?: string }) {
  const body = (
    <>
      <span className="cv-hash__tag">{tag ?? kind}</span>
      {short(value)}
    </>
  );
  if (!link)
    return (
      <span className="cv-hash" title={value}>
        {body}
      </span>
    );
  return (
    <a
      className="cv-hash"
      href={`${EXPLORER}/${explorerPath[kind]}/${value}`}
      target="_blank"
      rel="noopener"
      title={value}
      data-hash={value}
    >
      {body}
    </a>
  );
}

/** What the pill says: the contract status, or for a live agreement past maturity the time-derived state. */
export type DisplayState = Status | "Matured" | "Overdue";

const pill: Record<DisplayState, [string, string]> = {
  Open: ["open", "Open"],
  MarginCall: ["margin", "Margin call"],
  Matured: ["featured", "Matured"],
  Overdue: ["margin", "Overdue"],
  Repaid: ["repaid", "Repaid"],
  Defaulted: ["defaulted", "Defaulted"],
  Liquidated: ["defaulted", "Liquidated"],
};

/**
 * An Open agreement stays Open on-chain until a keeper or the lender acts: past maturity it reads
 * "Matured" (grace running) and past maturity + grace "Overdue" (strict, as the contract), so the
 * pill never says Open beside "Grace over". A margin call keeps its own word.
 */
export function displayState(r: { status: Status; maturity_ts: bigint }, graceSecs: bigint, now: number): DisplayState {
  if (r.status !== "Open") return r.status;
  if (now > Number(r.maturity_ts + graceSecs)) return "Overdue";
  if (now >= Number(r.maturity_ts)) return "Matured";
  return "Open";
}

export function StatusPill({ status }: { status: DisplayState }) {
  const [cls, word] = pill[status];
  return <span className={`cv-pill cv-pill--${cls}`}>{word}</span>;
}

export function Alert({
  tone,
  title,
  children,
  action,
}: {
  tone: "info" | "margin" | "error";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon = tone === "info" ? "i" : tone === "margin" ? "!" : "×";
  return (
    <div className={`cv-alert cv-alert--${tone}`} role={tone === "info" ? "status" : "alert"}>
      <span className="cv-alert__icon">{icon}</span>
      <div>
        <div className="cv-alert__title">{title}</div>
        {children && <div className="cv-alert__body">{children}</div>}
      </div>
      {action ?? <span />}
    </div>
  );
}

export function Field({
  id,
  label,
  value,
  onChange,
  suffix,
  hint,
  error,
  inputMode = "decimal",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix: string;
  hint?: ReactNode;
  error?: string | null;
  inputMode?: "decimal" | "numeric";
}) {
  return (
    <label className={`cv-field${error ? " cv-field--error" : ""}`}>
      <span className="cv-field__label">{label}</span>
      <span className="cv-field__control">
        <input
          id={id}
          name={id}
          inputMode={inputMode}
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="cv-field__suffix">{suffix}</span>
      </span>
      <span className="cv-field__hint" id={`${id}-hint`}>
        {error ?? hint}
      </span>
    </label>
  );
}

declare global {
  interface Window {
    Caravel?: {
      flash(el: Element | null, dir?: "up" | "down"): void;
      stamp(el: Element | null): void;
      live(el: Element | null, state: "on" | "stale" | "off", word?: string): void;
    };
  }
}

/** ValueFlash: glow a figure once when its value changes (design/components/ValueFlash).
 *  `dir` turns the glow healthy (up) or defaulted (down) when direction matters. */
export function useFlash<T, E extends HTMLElement = HTMLSpanElement>(
  value: T | null | undefined,
  dir?: (prev: T, next: T) => "up" | "down" | undefined,
) {
  const ref = useRef<E>(null);
  const prev = useRef(value);
  useEffect(() => {
    const p = prev.current;
    if (p !== null && p !== undefined && value !== null && value !== undefined && p !== value) {
      window.Caravel?.flash(ref.current, dir?.(p, value));
    }
    prev.current = value;
  }, [value, dir]);
  return ref;
}

/** Skeleton block shaped like the content it stands in for (design/components/Skeleton). */
export function Skel({ kind, w, h }: { kind?: "figure" | "line" | "short"; w?: number | string; h?: number }) {
  return <span className={`cv-skel${kind ? ` cv-skel--${kind}` : ""}`} style={w || h ? { width: w, height: h } : undefined} />;
}

/** LiveIndicator for a data feed: on (wave), stale (amber), off (hollow). */
export function Live({ state, word, meta }: { state: "on" | "stale" | "off"; word: string; meta?: string }) {
  return (
    <span className={`cv-live cv-live--${state}`} role="status">
      <span className="cv-live__dot" aria-hidden="true" />
      <span className="cv-live__word">{word}</span>
      {meta && <span className="cv-live__meta">{meta}</span>}
    </span>
  );
}

/** Transaction steps, in order. Index = TxState.step. */
export const TX_STEPS = ["Prepare", "Sign", "Submit", "Settled"] as const;
export interface TxError {
  title: string;
  body: string;
  hash?: string | null;
}
export interface TxState {
  key: string;
  step: number;
  failed: boolean;
  /** Set as soon as the network accepts the tx (Raven DW-02), before it is confirmed. */
  hash?: string;
  /** Why the write failed, shown under its own button (TxSlot) until dismissed or the next write. */
  error?: TxError;
}

// Action keys that have a TxSlot on screen right now: their errors render there, not in the page flash.
const slots = new Map<string, number>();
export const hasTxSlot = (key: string) => (slots.get(key) ?? 0) > 0;

/**
 * Progress and, on failure, the error of the write with one of `keys`, right under the button that
 * started it. While mounted it claims those keys, so App's runner skips the page-top flash for them.
 */
export function TxSlot({ tx, keys, demo, dismiss }: { tx: TxState | null; keys: string[]; demo: boolean; dismiss: () => void }) {
  const id = keys.join("|");
  useEffect(() => {
    const ks = id.split("|");
    for (const k of ks) slots.set(k, (slots.get(k) ?? 0) + 1);
    return () => {
      for (const k of ks) slots.set(k, (slots.get(k) ?? 1) - 1);
    };
  }, [id]);
  if (!tx || !keys.includes(tx.key)) return null;
  return (
    <>
      <TxProgress tx={tx} demo={demo} />
      {tx.error && (
        <Alert
          tone="error"
          title={tx.error.title}
          action={
            <button type="button" className="cv-btn cv-btn--quiet cv-btn--sm" onClick={dismiss}>
              Dismiss
            </button>
          }
        >
          {tx.error.body}
          {tx.error.hash && (
            <>
              {" "}
              <TxHash kind="TX" value={tx.error.hash} />
            </>
          )}
        </Alert>
      )}
    </>
  );
}

/** TxProgress: Prepare → Sign → Submit → Settled, with the active step carrying the tide. */
export function TxProgress({ tx, demo }: { tx: TxState; demo: boolean }) {
  const meta = ["simulating", demo ? "in browser" : "in wallet", "to Stellar", "≈5 s"];
  return (
    <>
    <ol className="cv-txprog" style={{ ["--steps" as string]: TX_STEPS.length }} aria-label="Transaction progress" data-testid="txprog">
      {TX_STEPS.map((label, i) => {
        const cls = i < tx.step ? " is-done" : i === tx.step ? (tx.failed ? " is-failed" : " is-active") : "";
        return (
          <li key={label} className={`cv-txprog__step${cls}`} aria-current={i === tx.step ? "step" : undefined}>
            <span className="cv-txprog__label">{label}</span>
            <span className="cv-txprog__meta">{i === tx.step && tx.failed ? "failed" : meta[i]}</span>
          </li>
        );
      })}
    </ol>
    {tx.hash && (
      <span className="cv-field__hint" data-testid="txprog-hash">
        Submitted <TxHash kind="TX" value={tx.hash} />
      </span>
    )}
    </>
  );
}

/** SealStamp, pressed once when a settlement lands. */
export function Seal({ word, sub, repaid }: { word: string; sub: string; repaid?: boolean }) {
  return (
    <span className={`cv-stamp${repaid ? " cv-stamp--repaid" : ""}`} role="status" data-testid="seal">
      <span>
        <b>{word}</b>
        {sub}
      </span>
    </span>
  );
}

export interface Leg {
  eyebrow: string;
  amount: string;
  unit: string;
  hint: string;
}

export interface Stamp {
  word: string;
  sub: string;
  repaid?: boolean;
}

export function DvpReceipt({
  left,
  right,
  sentence,
  hash,
  stamp,
}: {
  left: Leg;
  right: Leg;
  sentence: string;
  hash: string;
  stamp?: Stamp;
}) {
  const leg = (l: Leg) => (
    <div className="cv-dvp__leg">
      <span className="cv-eyebrow">{l.eyebrow}</span>
      <span>
        <span className="cv-num" style={{ fontSize: 18, fontWeight: 500 }}>
          {l.amount}
        </span>
        <span className="cv-unit">{l.unit}</span>
      </span>
      <span className="cv-field__hint">{l.hint}</span>
    </div>
  );
  const receipt = (
    <div className="cv-dvp" data-testid="dvp-receipt">
      {leg(left)}
      <span className="cv-dvp__arrow" aria-hidden="true">
        ⇄
      </span>
      {leg(right)}
      <div className="cv-dvp__foot">
        <span>{sentence}</span>
        <TxHash kind="TX" value={hash} />
      </div>
    </div>
  );
  if (!stamp) return receipt;
  // key on the hash so a new settlement remounts the seal and replays the press.
  return (
    <div className="app-receipt" key={hash}>
      {receipt}
      <div className="app-receipt__seal">
        <Seal {...stamp} />
      </div>
    </div>
  );
}

export function Busy({ busy, idle, children }: { busy: string | null; idle: string; children?: ReactNode }) {
  return <>{busy ?? children ?? idle}</>;
}

/** Plain-language line + this: the technical detail opens on hover or keyboard focus. */
export function Tip({ children }: { children: ReactNode }) {
  return (
    <span className="app-tip">
      <button type="button" className="app-tip__btn" aria-label="More info">
        i
      </button>
      <span className="app-tip__pop" role="tooltip">
        {children}
      </span>
    </span>
  );
}
