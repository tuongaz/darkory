import { CheckIcon, CopyIcon, LogInIcon, LogOutIcon, RotateCwIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { RunnerSession, TaskDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { sessionAnchor } from "@/app/peek";
import { searchKeys } from "@/app/shortcuts";
import { SectionHeader } from "@/components/PageHeader";
import { SessionFacts } from "@/components/RunnerSessionBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { joinCommand, type TerminalMode, type TerminalStatus } from "./terminal";

// xterm.js is loaded only when a panel shows a terminal.
const SessionTerminal = lazy(() => import("./SessionTerminal"));

const copyKeys = searchKeys.startsWith("⌘") ? "⌘C" : "Ctrl C";

/**
 * The session the Runner runs for the Task, shown only while it runs one: its facts, the shell
 * line that joins it from a terminal, and the terminal itself. Everyone watches (read-only);
 * an admin may Join, and the keyboard then goes to the session until Leave. A Join from elsewhere
 * (the agent's peek) arrives as the location state `{ join: true }`.
 */
export function SessionPanel({ detail, session, tall }: { detail: TaskDetail; session: RunnerSession; tall?: boolean }) {
  const me = useCurrentMe();
  const admin = me.member.admin;
  const { members } = useDirectory();
  const location = useLocation();
  const joinAsked = admin && (location.state as { join?: boolean } | null)?.join === true;
  const [mode, setMode] = useState<TerminalMode>(joinAsked ? "join" : "watch");
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const section = useRef<HTMLElement>(null);
  const key = detail.task.key;
  const joinable = !!session.tmux;

  useEffect(() => {
    if (location.hash === `#${sessionAnchor}`) section.current?.scrollIntoView({ block: "start" });
  }, [location.hash]);

  const action =
    admin && joinable ? (
      mode === "watch" ? (
        <Button variant="outline" size="xs" onClick={() => setMode("join")}>
          <LogInIcon />
          Join
        </Button>
      ) : (
        <Button variant="outline" size="xs" onClick={() => setMode("watch")}>
          <LogOutIcon />
          Leave
        </Button>
      )
    ) : null;

  return (
    <section ref={section} id={sessionAnchor} aria-label="Shift" className="flex scroll-mt-4 flex-col gap-2">
      <SectionHeader title="Shift" actions={action} />
      <div className="flex flex-col overflow-hidden rounded-md border">
        <SessionFacts session={session} agent={members.get(session.member_id)} className="min-h-9 border-b px-3 py-1.5" />
        {joinable ? (
          <>
            <ShellLine text={joinCommand(key)} />
            <Suspense fallback={<div className={cn("bg-background", tall ? "h-[420px]" : "h-[300px]")} />}>
              <SessionTerminal
                task={key}
                mode={mode}
                attempt={attempt}
                onStatus={setStatus}
                label={`Terminal of ${key}`}
                className={cn("border-b", tall ? "h-[420px]" : "h-[300px]")}
              />
            </Suspense>
            <p role="status" className="flex h-9 items-center gap-2 px-3 text-muted-foreground">
              <TerminalLine status={status} mode={mode} admin={admin} />
              {status === "closed" && (
                <Button variant="outline" size="xs" className="ml-auto" onClick={() => setAttempt((n) => n + 1)}>
                  <RotateCwIcon />
                  Reconnect
                </Button>
              )}
            </p>
          </>
        ) : (
          <p className="flex h-9 items-center px-3 text-muted-foreground">This Shift runs without tmux and cannot be joined</p>
        )}
      </div>
    </section>
  );
}

/** What the terminal is doing, in a few words. */
function TerminalLine({ status, mode, admin }: { status: TerminalStatus; mode: TerminalMode; admin: boolean }) {
  if (status === "connecting") return <>Connecting…</>;
  if (status === "closed") return <>The terminal closed</>;
  if (mode === "join") return <>Joined · your keys go to the Shift</>;
  return <>{admin ? "Read-only · Join to type" : "Read-only · admins can join"}</>;
}

/**
 * The shell line and its copy button. Without the clipboard (a page served over plain http away
 * from localhost) the line is selected for the reader to copy, and the button says so.
 */
function ShellLine({ text }: { text: string }) {
  const code = useRef<HTMLElement>(null);
  const [done, setDone] = useState<"copied" | "selected" | null>(null);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 2000);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone("copied");
    } catch {
      const selection = window.getSelection();
      if (code.current && selection) selection.selectAllChildren(code.current);
      setDone("selected");
    }
  };
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 border-b bg-muted px-3">
      <span aria-hidden className="font-mono text-xs text-muted-foreground">
        $
      </span>
      <code ref={code} className="min-w-0 truncate font-mono text-xs">
        {text}
      </code>
      {done === "selected" && <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">Selected · press {copyKeys}</span>}
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("text-muted-foreground", done !== "selected" && "ml-auto")}
        aria-label={done === "copied" ? "Copied" : `Copy ${text}`}
        onClick={() => void copy()}
      >
        {done === "copied" ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
