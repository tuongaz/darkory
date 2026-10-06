import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { FakeEventSource } from "./eventSource";
import { FakeWebSocket } from "./webSocket";

globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

// What Radix, cmdk and the Sidebar ask of the browser and jsdom lacks. The window is a desktop
// one: no media query matches, so the Sidebar is not a sheet.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// jsdom has no canvas and says so on every call; xterm.js asks once, and does without.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
Element.prototype.scrollIntoView ??= function () {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  FakeWebSocket.instances = [];
});
