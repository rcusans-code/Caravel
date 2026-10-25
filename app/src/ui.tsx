// Thin React wrappers over the design system markup (design/components/*/preview.html).
import type { ReactNode } from "react";
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

export interface Leg {
  eyebrow: string;
  amount: string;
  unit: string;
  hint: string;
}

export function DvpReceipt({ left, right, sentence, hash }: { left: Leg; right: Leg; sentence: string; hash: string }) {
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
  return (
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
}

export function Busy({ busy, idle, children }: { busy: string | null; idle: string; children?: ReactNode }) {
  return <>{busy ?? children ?? idle}</>;
}
