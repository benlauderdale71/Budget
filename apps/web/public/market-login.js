(async () => {
  const current = `${location.pathname}${location.search}${location.hash}`;
  let destination = "/stocks-crypto/";
  try {
    const decoded = decodeURIComponent(current);
    const url = new URL(current, location.origin);
    if (current.length <= 300 && url.origin === location.origin && /^\/stocks-crypto(?:\/|$)/.test(url.pathname)
      && !/[\\\u0000-\u001f]/.test(decoded) && !decoded.includes("://")
      && !decoded.split("/").some((part) => part === "." || part === "..")) destination = current;
  } catch { /* An invalid path returns to the market home. */ }
  const signIn = () => location.replace(`/login?next=${encodeURIComponent(destination)}`);
  const retry = () => {
    const status = document.getElementById("market-login-status");
    if (!status) return;
    status.textContent = "Market Pulse could not connect to your sign-in. Please try again.";
    const link = document.createElement("a");
    link.href = destination;
    link.textContent = "Try again";
    status.append(document.createTextNode(" "), link);
  };
  let token;
  try { token = localStorage.getItem("budgetcents.token"); } catch { signIn(); return; }
  if (!token) { signIn(); return; }
  try {
    const response = await fetch("/api/auth/market-session", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) { signIn(); return; }
    if (!response.ok) { retry(); return; }
    location.replace(destination);
  } catch { retry(); }
})();
