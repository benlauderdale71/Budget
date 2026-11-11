import { describe, expect, it } from "vitest";
import {
  groupImportRows,
  mapCsv,
  netOutflow,
  parseOfx,
  parseQif,
  planCategoryAssignments,
  rowsFromBank,
} from "../src/importers.js";

describe("import splits and coverage", () => {
  it("keeps a proportional split exact and does not give a one-cent gap to the last category", () => {
    const csv = [
      "Date,Payee,Amount,Splits,Notes,Tags,Balance",
      "2026-11-02,Market,-8.80,Groceries:5.50|Household:3.30,weekly,food|home,91.20",
      "2026-11-03,Market,-3.01,A:1.00|B:1.00|C:1.00,short,,",
      "2026-11-04,Market,-3.01,A:1.00|B:1.00|C:1.01,exact,,",
    ].join("\n");
    const rows = mapCsv(csv, {});
    expect(rows[0].splits).toEqual([
      { category: "Groceries", amountMinor: 550, role: "expense" },
      { category: "Household", amountMinor: 330, role: "expense" },
    ]);
    expect(rows[0].notes).toBe("weekly");
    expect(rows[0].tags).toEqual(["food", "home"]);
    expect(rows[0].observedBalanceMinor).toBe(9120);
    expect(rows[0].amountMinor).toBe(-880);
    expect(rows[0].errors).toEqual([]);
    expect(netOutflow(rows[0].splits!)).toBe(880);

    expect(rows[1].errors[0]).toContain("was not assigned to a category");
    expect(rows[1].splits?.[2].amountMinor).toBe(100);

    expect(rows[2].errors).toEqual([]);
    expect(rows[2].splits?.map((split) => split.amountMinor)).toEqual([100, 100, 101]);
    expect(netOutflow(rows[2].splits!)).toBe(301);
    const again = mapCsv(csv, {});
    expect(again[2].splits).toEqual(rows[2].splits);
  });

  it("groups split rows into one transaction and leaves unrelated rows alone", () => {
    const csv = [
      "Date,Payee,Outflow,Inflow,Category,Split Group,Memo",
      "11/02/2026,Market,5.50,,Groceries,store,apples",
      "11/02/2026,Market,3.30,,Household,store,soap",
      "11/03/2026,Cafe,4.00,,Fun,,",
    ].join("\n");
    const groups = groupImportRows(mapCsv(csv, { debit: "Outflow", credit: "Inflow", notes: "Memo" }));
    expect(groups).toHaveLength(2);
    expect(groups[0].amountMinor).toBe(-880);
    expect(groups[0].rowNumbers).toEqual([2, 3]);
    expect(groups[0].splits.map((split) => [split.category, split.amountMinor])).toEqual([
      ["Groceries", 550],
      ["Household", 330],
    ]);
    expect(groups[0].notes).toBe("apples\nsoap");
    expect(groups[0].errors).toEqual([]);
    expect(groups[1].amountMinor).toBe(-400);
    expect(groups[1].splits[0].category).toBe("Fun");
  });

  it("reads day-month dates and comma decimals without posting the balance", () => {
    const rows = mapCsv("Date,Payee,Amount,Balance\n31/01/2026,Market,\"-8,80\",\"1.234,56\"\n", { date: "Date", payee: "Payee", amount: "Amount", balance: "Balance" }, { dateOrder: "dmy", decimal: "comma" });
    expect(rows[0].date).toBe("2026-01-31");
    expect(rows[0].amountMinor).toBe(-880);
    expect(rows[0].observedBalanceMinor).toBe(123456);
    expect(rows[0].errors).toEqual([]);
    const swapped = mapCsv("Date,Payee,Amount\n31/01/2026,Market,-1.00\n", { date: "Date", payee: "Payee", amount: "Amount" }, { dateOrder: "mdy" });
    expect(swapped[0].errors[0]).toContain("month/day/year");
  });

  it("keeps a negative split as a refund and reads QIF and OFX fields", () => {
    const rows = mapCsv("Date,Payee,Amount,Splits\n2026-11-02,Market,-4.50,Groceries:5.50|Return:-1.00\n", {});
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].splits).toEqual([
      { category: "Groceries", amountMinor: 550, role: "expense" },
      { category: "Return", amountMinor: 100, role: "refund" },
    ]);
    const qif = parseQif("D11/02/2026\nPMarket\nT-8.80\nMweekly\nLSplit\nSGroceries\n$-5.50\nSHousehold\n$-3.30\n^\n");
    const grouped = groupImportRows(rowsFromBank(qif));
    expect(grouped[0].amountMinor).toBe(-880);
    expect(grouped[0].notes).toBe("weekly");
    expect(grouped[0].splits.map((split) => split.amountMinor)).toEqual([550, 330]);
    expect(grouped[0].errors).toEqual([]);
    const ofx = parseOfx("<OFX><CURDEF>USD<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261102<TRNAMT>-4.00<FITID>fit-1<NAME>Market<MEMO>kept</STMTTRN><STMTTRN><TRNTYPE>XFER<DTPOSTED>20261103<TRNAMT>-2.00<FITID>fit-2<NAME>Savings</STMTTRN></OFX>");
    const debit = ofx.find((row) => row.fitId === "fit-1");
    const transfer = ofx.find((row) => row.fitId === "fit-2");
    expect(debit).toMatchObject({ notes: "kept", fitId: "fit-1", currency: "USD", amountMinor: -400 });
    expect((transfer?.errors ?? []).join(" ")).toContain("transfer");
  });

  it("matches categories explicitly and refuses a missing, archived, or wrong-kind category", () => {
    const buckets = [
      { id: "g", name: "Groceries", kind: "expense", archived: false },
      { id: "g2", name: "Groceries", kind: "expense", archived: false },
      { id: "old", name: "Pets", kind: "expense", archived: true },
      { id: "pay", name: "Paychecks", kind: "income", archived: false },
    ];
    expect(planCategoryAssignments([{ name: "Groceries", kind: "expense" }], buckets, { Groceries: "g" }, false).assignments).toEqual([
      { name: "Groceries", kind: "expense", bucketId: "g" },
    ]);
    expect(planCategoryAssignments([{ name: "Pets", kind: "expense" }], buckets, {}, false).errors[0]).toContain("not in this plan");
    expect(planCategoryAssignments([{ name: "Pets", kind: "expense" }], buckets, {}, true).assignments[0].create).toBe(true);
    expect(planCategoryAssignments([{ name: "Groceries", kind: "expense" }], buckets, {}, false).errors[0]).toContain("more than one");
    expect(planCategoryAssignments([{ name: "Pay", kind: "expense" }], buckets, { Pay: "pay" }, false).errors[0]).toContain("income");
    expect(planCategoryAssignments([{ name: "Pets", kind: "expense" }], buckets, { Pets: "missing" }, false).errors[0]).toContain("not in this plan");
  });
});
