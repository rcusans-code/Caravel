// Thin React wrappers over the design system markup (design/components/*/preview.html).
import { useEffect, useRef, type ReactNode } from "react";
import { EXPLORER } from "./config";
import type { Status } from "./chain";
import { short } from "./format";

type HashKind = "TX" | "CONTRACT" | "ACCOUNT";
const explorerPath: Record<HashKind, string> = { TX: "tx", CONTRACT: "contract", ACCOUNT: "account" };

export function TxHash({ kind, value, link = true }: { kind: HashKind; value: string; link?: boolean }) {
  const body = (
    <>
      <span className="cv-hash__tag">{kind}</span>
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

const pill: Record<Status, [string, string]> = {
  Open: ["open", "Open"],
  MarginCall: ["margin", "Margin call"],
  Repaid: ["repaid", "Repaid"],
  Defaulted: ["defaulted", "Defaulted"],
  Liquidated: ["defaulted", "Liquidated"],
};

export function StatusPill({ status }: { status: Status }) {
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
export interface TxState {
  key: string;
  step: number;
  failed: boolean;
}

/** TxProgress: Prepare → Sign → Submit → Settled, with the active step carrying the tide. */
export function TxProgress({ tx, demo }: { tx: TxState; demo: boolean }) {
  const meta = ["simulating", demo ? "in browser" : "in wallet", "to Stellar", "≈5 s"];
  return (
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
