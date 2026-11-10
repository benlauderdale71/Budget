const EXPONENTS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3, OMR: 3 };

export function exponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

export function formatMoney(minor: number, currency = "USD", hidden = false): string {
  if (hidden) return "••••";
  const factor = 10 ** exponent(currency);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: exponent(currency) }).format(minor / factor);
  } catch {
    return `${(minor / factor).toFixed(exponent(currency))} ${currency}`;
  }
}

export function parseAmount(text: string, currency = "USD"): number {
  const cleaned = text.trim().replace(/[$,\s]/g, "");
  if (!cleaned) throw new Error("Enter an amount.");
  const places = exponent(currency);
  const pattern = places === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+(\\.\\d{0,${places}})?$`);
  if (!pattern.test(cleaned)) throw new Error(places === 0 ? "Use a whole number." : `Use up to ${places} decimal places.`);
  const negative = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const minor = Number(whole) * 10 ** places + Number(frac.padEnd(places, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("That amount is too large.");
  return negative ? -minor : minor;
}

export function minorToInput(minor: number, currency = "USD"): string {
  const places = exponent(currency);
  const factor = 10 ** places;
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(places, "0");
  return places === 0 ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

export function todayISO(): string {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
