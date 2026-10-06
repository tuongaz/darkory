import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import "./globals.css";
import { followSystemTheme } from "./lib/theme";

followSystemTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={(root) => <BrowserRouter>{root}</BrowserRouter>} />
  </StrictMode>,
);
