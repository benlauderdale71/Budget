import { MoneyError } from "./money.js";

export interface TaxLot {
  id: string;
  quantityMicro: number;
  costBasisMinor: number;
  acquired: string;
}

export interface LotSale {
  lotId: string;
  quantityMicro: number;
  basisMinor: number;
  proceedsMinor: number;
  gainMinor: number;
}

/** FIFO sale. Quantity is in millionths of a share so the result stays an integer. */
export function realizeFifo(lots: TaxLot[], sellQuantityMicro: number, proceedsMinor: number): { sales: LotSale[]; remaining: TaxLot[]; gainMinor: number } {
  if (!Number.isSafeInteger(sellQuantityMicro) || sellQuantityMicro <= 0) throw new MoneyError("Sell a positive whole number of millionths of a share.");
  if (!Number.isSafeInteger(proceedsMinor) || proceedsMinor < 0) throw new MoneyError("Proceeds must be non-negative integer minor units.");
  if (new Set(lots.map((lot) => lot.id)).size !== lots.length || lots.some((lot) => !Number.isSafeInteger(lot.quantityMicro) || lot.quantityMicro <= 0 || !Number.isSafeInteger(lot.costBasisMinor) || lot.costBasisMinor < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(lot.acquired) || !Number.isFinite(Date.parse(lot.acquired)) || new Date(lot.acquired).toISOString().slice(0, 10) !== lot.acquired)) throw new MoneyError("Each lot needs a unique id, a valid date, positive quantity, and non-negative basis.");
  const ordered = [...lots].sort((a, b) => a.acquired.localeCompare(b.acquired) || a.id.localeCompare(b.id));
  const available = ordered.reduce((sum, lot) => sum + BigInt(lot.quantityMicro), 0n);
  if (BigInt(sellQuantityMicro) > available) throw new MoneyError("That sale is larger than the remaining lots.");
  let left = sellQuantityMicro;
  let basis = 0;
  const sales: LotSale[] = [];
  const remaining: TaxLot[] = [];
  for (const lot of ordered) {
    if (left <= 0) {
      remaining.push(lot);
      continue;
    }
    const take = Math.min(lot.quantityMicro, left);
    const takenBasis = Number(BigInt(lot.costBasisMinor) * BigInt(take) / BigInt(lot.quantityMicro));
    const takenProceeds = Number(BigInt(proceedsMinor) * BigInt(take) / BigInt(sellQuantityMicro));
    sales.push({ lotId: lot.id, quantityMicro: take, basisMinor: takenBasis, proceedsMinor: takenProceeds, gainMinor: takenProceeds - takenBasis });
    basis += takenBasis;
    if (!Number.isSafeInteger(basis)) throw new MoneyError("The combined cost basis is too large.");
    left -= take;
    if (take < lot.quantityMicro) remaining.push({ ...lot, quantityMicro: lot.quantityMicro - take, costBasisMinor: lot.costBasisMinor - takenBasis });
  }
  const proceedsUsed = sales.reduce((sum, sale) => sum + sale.proceedsMinor, 0);
  if (proceedsUsed !== proceedsMinor && sales.length) sales[sales.length - 1].proceedsMinor += proceedsMinor - proceedsUsed;
  if (sales.length) sales[sales.length - 1].gainMinor = sales[sales.length - 1].proceedsMinor - sales[sales.length - 1].basisMinor;
  const gainMinor = proceedsMinor - basis;
  return { sales, remaining, gainMinor };
}
