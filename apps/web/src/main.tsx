import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { connectDevice, isDeviceSuite } from "./device-suite.js";
import { App } from "./App.js";
import { SessionProvider } from "./session.js";
import "./styles.css";

if (!isDeviceSuite() && import.meta.env.PROD && "serviceWorker" in navigator) {
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
    // A ready worker may predate React's Shell listener (e.g. an installed app
    // left open across a rename). Keep the update notice discoverable on return.
    const check = () => { announce(); void registration.update().catch(() => undefined); };
    window.addEventListener("focus", check);
    setInterval(check, 60_000);
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", announce);
    });
  }).catch(() => undefined);
}

void connectDevice().then(()=>createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
));
