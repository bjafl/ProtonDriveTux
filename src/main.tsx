import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayPopup } from "./components/TrayPopup";
import { ThemeProvider } from "./lib/theme";
import { LangProvider } from "./lib/i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isTrayPopup = getCurrentWindow().label === "tray-popup";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      {isTrayPopup ? (
        <LangProvider>
          <TrayPopup />
        </LangProvider>
      ) : (
        <LangProvider>
          <App />
        </LangProvider>
      )}
    </ThemeProvider>
  </React.StrictMode>,
);
