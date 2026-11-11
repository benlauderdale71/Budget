import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { SessionProvider } from "./session.js";
import "./styles.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || sessionStorage.getItem("budgetcents.reload") !== "1") return;
    sessionStorage.removeItem("budgetcents.reload");
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    const announce = () => {
      if (registration.waiting && navigator.serviceWorker.controller) window.dispatchEvent(new Event("budgetcents-update"));
    };
    announce();
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", announce);
    });
  }).catch(() => undefined);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
