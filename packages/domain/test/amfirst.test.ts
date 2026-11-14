import { describe, expect, it } from "vitest";
import { groupImportRows, importFieldReport, mapCsv, parseAmount, parseCsv, resolvedColumnMap } from "../src/importers.js";

// Synthetic records with the bank's export schema. No customer data.
export const headers = ["Transaction ID", "Posting Date", "Effective Date", "Transaction Type", "Posting Status", "Amount", "Check Number", "Reference Number", "Description", "Transaction Category", "Type", "Balance", "Memo", "Extended Description"];
export const cells = ["20261114 010000 1,234 5,678", "11/14/2026", "", "Check", "Posted", "-12.34000", "0007", "000009", "Example, shop", "Shopping", "", "987.66000", "first line\nsecond line", "Example, shop extended details"];
const encode = (row: string[]) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",");
export const bankCsv = [headers, cells].map(encode).join("\r\n");

describe("bank CSV accuracy", () => {
  it("automatically reads the credit-union headers and preserves all 14 original cells", () => {
    const [row] = mapCsv("\uFEFF" + bankCsv, {});
    expect(row.errors).toEqual([]);
    expect(row).toMatchObject({ date: "2026-11-14", amountMinor: -1234, observedBalanceMinor: 98766, payee: "Example, shop", description: cells[13], checkNumber: "0007", referenceNumber: "000009", fitId: cells[0], transactionType: "Check", bankStatus: "posted", bankCategory: "Shopping", notes: "first line second line" });
    expect(row.effectiveDate).toBeUndefined();
    expect(row.sourceCells).toEqual(headers.map((column, index) => ({ column, value: cells[index] })));
    expect(row.splits).toBeUndefined(); // A bank's label is not a budget assignment.
    expect(resolvedColumnMap(bankCsv, {}).transactionType).toBe("Transaction Type");
    expect(groupImportRows([row])[0]).toMatchObject({ csvSource: true, fitId: cells[0], originalDescription: cells[13] });
  });

  it("accepts zero-padded cents and refuses nonzero sub-cent digits without rounding", () => {
    expect(parseAmount("-12.34000")).toBe(-1234);
    expect(parseAmount("0.01000")).toBe(1);
    expect(parseAmount("1.00100")).toBeUndefined();
    expect(parseAmount("1.99999")).toBeUndefined();
    expect(parseAmount("90071992547409.92")).toBeUndefined();
  });

  it("checks the debit/credit sign, dates, posting status, and cell count", () => {
    const withCell = (index: number, value: string) => mapCsv([encode(headers), encode(cells.map((cell, i) => i === index ? value : cell))].join("\n"), {})[0];
    expect(withCell(3, "Credit").errors.join(" ")).toContain("sign disagrees");
    expect(withCell(2, "02/30/2026").errors.join(" ")).toContain("Effective date");
    expect(withCell(4, "Unknown").errors.join(" ")).toContain("Posting status");
    expect(withCell(4, "Pending").bankStatus).toBe("pending");
    expect(withCell(9, "Transfers").requiresTransferReview).toBe(true);
    expect(withCell(9, "Credit Card Payments").requiresTransferReview).toBe(true);
    expect(mapCsv(bankCsv + ",unexpected", {})[0].errors.join(" ")).toContain("number of cells");
    expect(() => parseCsv('Date,Amount\n"unfinished,1.00')).toThrow("unfinished");
  });

  it("keeps unknown and blank columns and the first listed balance on the newest day", () => {
    const csv = "Posting Date,Amount,Balance,Extra,Empty\n11/14/2026,-1.00000,8.00000,keep,\n11/14/2026,-1.00000,9.00000,keep too,\n11/13/2026,-1.00000,10.00000,,";
    const rows = mapCsv(csv, {});
    expect(rows[0].sourceCells?.slice(-2)).toEqual([{ column: "Extra", value: "keep" }, { column: "Empty", value: "" }]);
    expect(importFieldReport(rows, []).balances[0].balanceMinor).toBe(800);
  });
});
