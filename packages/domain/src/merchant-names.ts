/** Report-only grouping. Original bank descriptions and ledger records are never rewritten. */
export function spendingMerchantName(payee: string): string {
  const original = payee.normalize("NFKC").trim().replace(/\s+/g, " ");
  const normalized = original.toUpperCase().replace(/[’']/g, "");
  // Remove common bank prefixes, but do not match a brand buried inside another business name.
  const name = normalized.replace(/^(?:(?:POS|DEBIT CARD|CHECKCARD|CHECK CARD|CARD|VISA|MASTERCARD|RECURRING|PURCHASE|PAYMENT|DEBIT|POINT OF SALE|RETURN|ADJUSTMENT)\s+)+/, "").replace(/^\d{4}\s+/, "");
  const brands: [RegExp, string][] = [
    [/^(?:WAL[ -]?MART|WALMART(?:\.COM)?|WM SUPERCENTER)(?=$|[\s*#.-]|\d)/, "Walmart"],
    [/^(?:AMAZON(?:\.COM)?|AMZN(?: MKTP| MKTPLACE| DIGITAL| PRIME)?)(?=$|[\s*#.-]|\d)/, "Amazon"],
    [/^MCDONALDS(?=$|[\s*#.-]|\d)/, "McDonald's"],
    [/^BURGER KING(?=$|[\s*#.-]|\d)/, "Burger King"],
    [/^CURSOR(?:\.COM|\.SO)?(?=$|[\s*#,.-])/, "Cursor"],
    [/^TACO BELL(?=$|[\s*#.-]|\d)/, "Taco Bell"],
    [/^DOLLAR GENERAL(?=$|[\s*#.-]|\d)/, "Dollar General"],
    [/^WALGREENS(?=$|[\s*#.-]|\d)/, "Walgreens"],
    [/^CVS(?:\/PHARMACY)?(?=$|[\s*#.-]|\d)/, "CVS"],
    [/^FOODLAND(?=$|[\s*#.-]|\d)/, "Foodland"],
    [/^(?:PAR\*)?JACKS(?=$|[\s*#.-]|\d)/, "Jack's"],
    [/^TARGET(?=$|[\s*#.-]|\d)/, "Target"],
    [/^COSTCO(?=$|[\s*#.-]|\d)/, "Costco"],
    [/^SAMS CLUB(?=$|[\s*#.-]|\d)/, "Sam's Club"],
    [/^(?:THE )?HOME DEPOT(?=$|[\s*#.-]|\d)/, "Home Depot"],
    [/^LOWES(?=$|[\s*#.-]|\d)/, "Lowe's"],
    [/^KROGER(?=$|[\s*#.-]|\d)/, "Kroger"],
    [/^SHELL(?=$|[\s*#.-]|\d)/, "Shell"],
    [/^CHEVRON(?=$|[\s*#.-]|\d)/, "Chevron"],
    [/^EXXON(?:MOBIL)?(?=$|[\s*#.-]|\d)/, "Exxon"],
    [/^MOBIL(?=$|[\s*#.-]|\d)/, "Mobil"],
    [/^BP(?=$|[\s*#.-]|\d)/, "BP"],
    [/^CIRCLE K(?=$|[\s*#.-]|\d)/, "Circle K"],
    [/^SPEEDWAY(?=$|[\s*#.-]|\d)/, "Speedway"],
    [/^TEXACO(?=$|[\s*#.-]|\d)/, "Texaco"],
    [/^MARATHON(?=$|[\s*#.-]|\d)/, "Marathon"],
    [/^MURPHY (?:USA|EXPRESS)(?=$|[\s*#.-]|\d)/, "Murphy"],
    [/^BUC[ -]?EES(?=$|[\s*#.-]|\d)/, "Buc-ee's"],
    [/^7[ -]?ELEVEN(?=$|[\s*#.-]|\d)/, "7-Eleven"],
  ];
  return brands.find(([pattern]) => pattern.test(name))?.[1] ?? (normalized || "Unknown merchant");
}
