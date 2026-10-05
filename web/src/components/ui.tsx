import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { useNow } from "../clock";

/** A refusal or failure, showing the API's stable code beside its message. */
export function Refusal({ error }: { error: unknown }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : "network";
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="refusal">
      <code>{code}</code> {message}
    </p>
  );
}

/** Renders a query's data, or its loading state or refusal. */
export function Loaded<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <Refusal error={query.error} />;
  return <>{children(query.data)}</>;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function Time({ at }: { at: string | undefined }) {
  if (!at) return null;
  return <time dateTime={at}>{dateTime.format(new Date(at))}</time>;
}

/** A time as "in 4 minutes" or "2 hours ago", with the full time on hover. */
export function RelativeTime({ at }: { at: string }) {
  const now = useNow();
  const seconds = (new Date(at).getTime() - now) / 1000;
  const abs = Math.abs(seconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [seconds, "second"]
      : abs < 3600
        ? [seconds / 60, "minute"]
        : abs < 86400
          ? [seconds / 3600, "hour"]
          : [seconds / 86400, "day"];
  return (
    <time dateTime={at} title={dateTime.format(new Date(at))}>
      {relative.format(Math.round(value), unit)}
    </time>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge${tone ? ` badge-${tone}` : ""}`}>{children}</span>;
}

/** Shows a value with a button that copies it. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <label>
        {label}
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** A button that asks again before doing something that cannot be undone. */
export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  disabled,
  label,
}: {
  children: ReactNode;
  confirm: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  /** The first button's accessible name, when its text alone would be ambiguous. */
  label?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="danger" aria-label={label} disabled={disabled} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="confirm">
      <button
        type="button"
        className="danger"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirm}
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
