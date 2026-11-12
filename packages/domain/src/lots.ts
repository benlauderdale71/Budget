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
  if (!Number.isInteger(sellQuantityMicro) || sellQuantityMicro <= 0) throw new MoneyError("Sell a positive whole number of millionths of a share.");
  if (!Number.isInteger(proceedsMinor)) throw new MoneyError("Proceeds must be integer minor units.");
  const ordered = [...lots].sort((a, b) => a.acquired.localeCompare(b.acquired) || a.id.localeCompare(b.id));
  const available = ordered.reduce((sum, lot) => sum + lot.quantityMicro, 0);
  if (sellQuantityMicro > available) throw new MoneyError("That sale is larger than the remaining lots.");
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
    const takenBasis = Math.floor((lot.costBasisMinor * take) / lot.quantityMicro);
    const takenProceeds = Math.floor((proceedsMinor * take) / sellQuantityMicro);
    sales.push({ lotId: lot.id, quantityMicro: take, basisMinor: takenBasis, proceedsMinor: takenProceeds, gainMinor: takenProceeds - takenBasis });
    basis += takenBasis;
    left -= take;
    if (take < lot.quantityMicro) remaining.push({ ...lot, quantityMicro: lot.quantityMicro - take, costBasisMinor: lot.costBasisMinor - takenBasis });
  }
  const proceedsUsed = sales.reduce((sum, sale) => sum + sale.proceedsMinor, 0);
  if (proceedsUsed !== proceedsMinor && sales.length) sales[sales.length - 1].proceedsMinor += proceedsMinor - proceedsUsed;
  if (sales.length) sales[sales.length - 1].gainMinor = sales[sales.length - 1].proceedsMinor - sales[sales.length - 1].basisMinor;
  const gainMinor = proceedsMinor - basis;
  return { sales, remaining, gainMinor };
}
