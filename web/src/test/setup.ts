import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { FakeEventSource } from "./eventSource";

globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
});
