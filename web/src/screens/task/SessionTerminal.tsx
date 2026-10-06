import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { ownsKeysAttr } from "@/lib/keys";
import { cn } from "@/lib/utils";
import { resizeFrame, terminalURL, type TerminalMode, type TerminalStatus } from "./terminal";

/**
 * The app's colours for the terminal, read from the tokens. jsdom computes no tokens, and xterm
 * reads a colour such as oklch() only through a canvas: it keeps its own colours then.
 */
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const background = token("--background");
  const foreground = token("--foreground");
  if (!background || !foreground) return {};
  return { background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: token("--ring") || undefined };
}

/**
 * xterm.js connected to a Task's session (the panel loads this module only when it shows a
 * terminal). One xterm for the panel's life; a new WebSocket for each mode and Reconnect, each
 * starting from a cleared screen, which tmux redraws. Watching, stdin is off and Esc gives the
 * keys back to the app; joined, every key goes to the session, Esc included.
 */
export default function SessionTerminal({
  task,
  mode,
  attempt,
  onStatus,
  label,
  className,
}: {
  task: string;
  mode: TerminalMode;
  /** Bumped by Reconnect: a new connection in the same mode. */
  attempt: number;
  onStatus: (status: TerminalStatus) => void;
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const xterm = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const latest = useRef({ mode, onStatus });
  useEffect(() => {
    latest.current = { mode, onStatus };
  });

  useEffect(() => {
    const el = box.current!;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace",
      theme: theme(),
      scrollback: 5000,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape" && latest.current.mode === "watch") {
        term.blur();
        return false;
      }
      return true;
    });
    term.open(el);
    xterm.current = { term, fit };
    // The panel slides in with the peek: fit once it has a size, and again whenever it changes.
    const refit = () => el.clientWidth > 0 && fit.fit();
    const resized = new ResizeObserver(refit);
    resized.observe(el);
    // The app follows the system between light and dark by a class on <html>.
    const themed = new MutationObserver(() => (term.options.theme = theme()));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      resized.disconnect();
      themed.disconnect();
      term.dispose();
      xterm.current = null;
    };
  }, []);

  useEffect(() => {
    const { term, fit } = xterm.current!;
    const joined = mode === "join";
    term.reset();
    term.options.disableStdin = !joined;
    latest.current.onStatus("connecting");
    const ws = new WebSocket(terminalURL(task, !joined));
    ws.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    const send = (data: string | Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(data);
    const sendSize = () => send(resizeFrame(term.cols, term.rows));
    ws.onopen = () => {
      latest.current.onStatus("open");
      if (box.current && box.current.clientWidth > 0) fit.fit();
      sendSize();
      if (joined) term.focus();
    };
    // Binary frames are the terminal's bytes (an ArrayBuffer, by binaryType); text frames are not.
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => latest.current.onStatus("closed");
    const subscriptions = [
      term.onResize(sendSize),
      term.onData((data) => joined && send(encoder.encode(data))),
      // Mouse reports in the X10 encoding: one byte per character.
      term.onBinary((data) => joined && send(Uint8Array.from(data, (c) => c.charCodeAt(0)))),
    ];
    return () => {
      for (const s of subscriptions) s.dispose();
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
      if (joined) term.blur();
    };
  }, [task, mode, attempt]);

  return (
    <div
      ref={box}
      role="group"
      aria-label={label}
      {...{ [ownsKeysAttr]: "" }}
      data-mode={mode}
      className={cn("min-h-0 overflow-hidden bg-background px-2 py-1.5", className)}
    />
  );
}
