import type { Cadence } from "./dates.js";

export type AccountKind =
  | "checking"
  | "savings"
  | "cash"
  | "credit"
  | "loan"
  | "student_loan"
  | "mortgage"
  | "brokerage"
  | "retirement"
  | "education"
  | "crypto"
  | "property"
  | "vehicle"
  | "other_asset"
  | "other_liability";

export type BudgetApproach = "category" | "zero" | "envelope" | "flex";

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  /** Included in the spendable cash pool (checking, savings, cash). */
  onBudget: boolean;
  hidden?: boolean;
  archived?: boolean;
  excludeFromNetWorth?: boolean;
  institution?: string;
  mask?: string;
  ownerUserId?: string;
  spaceId?: string;
  creditLimitMinor?: number;
  aprBps?: number;
  minimumPaymentMinor?: number;
  /** Linked property/vehicle account id for equity pairing. */
  linkedAccountId?: string;
}

export type BucketKind = "income" | "expense";
export type FlexRole = "fixed" | "non_monthly" | "flexible" | "income" | "reserve";
export type EnvelopeStyle = "regular" | "annual" | "goal" | "debt" | "none";
export type RolloverMode = "both" | "positive" | "negative" | "none" | "capped";
export type TargetType = "refill" | "set_aside" | "balance_by_date" | "maintain_balance" | "debt_payment";
export type SystemRole = "cc_reserve" | "borrowed_funds" | "buffer" | null;

export interface Target {
  type: TargetType;
  amountMinor: number;
  cadence: Cadence;
  dueDate?: string;
  pausedUntil?: string;
  /** Share of income that has already posted, in basis points. 1000 is 10 percent. Expected income is not used. */
  percentBps?: number;
}

export interface Bucket {
  id: string;
  name: string;
  group: string;
  kind: BucketKind;
  flexRole: FlexRole;
  envelopeStyle: EnvelopeStyle;
  rollover: RolloverMode;
  rolloverCapMinor?: number;
  icon?: string;
  archived?: boolean;
  hidden?: boolean;
  displayOrder?: number;
  target?: Target;
  systemRole?: SystemRole;
  linkedAccountId?: string;
  purpose?: "emergency" | "giving" | "sinking" | "debt" | "goal" | "general";
  dueDay?: number;
  version?: number;
  /** Latest saved rollover rule. The original rollover stays in `rollover` so earlier months do not change. */
  displayRollover?: RolloverMode;
  displayRolloverCapMinor?: number;
  rolloverEffectivePeriod?: string;
}

export type TransactionType =
  | "income"
  | "expense"
  | "transfer"
  | "refund"
  | "reimbursement"
  | "cc_payment"
  | "loan_payment"
  | "loan_proceeds"
  | "opening"
  | "reconciliation"
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "fee";

export type BankStatus = "pending" | "posted";
export type ReviewStatus = "needs_review" | "reviewed";

export type SplitRole = "expense" | "income" | "principal" | "interest" | "fee" | "escrow" | "transfer" | "refund";

export interface Split {
  bucketId: string | null;
  amountMinor: number;
  role: SplitRole;
  memo?: string;
  ownerUserId?: string;
  businessSpaceId?: string;
  project?: string;
  taxCode?: string;
}

export interface Transaction {
  id: string;
  date: string;
  accountId: string;
  counterAccountId?: string;
  /** Signed in bank-export convention: negative leaves the primary account, positive enters it. */
  amountMinor: number;
  currency: string;
  type: TransactionType;
  payee: string;
  originalDescription?: string;
  splits: Split[];
  bankStatus: BankStatus;
  reviewStatus: ReviewStatus;
  reviewerUserId?: string;
  reviewAssignedBy?: string;
  reviewAssignedAt?: string;
  reviewResolvedBy?: string;
  reviewResolvedAt?: string;
  cleared?: boolean;
  reconciled?: boolean;
  locked?: boolean;
  categoryLockedByUser?: boolean;
  tags?: string[];
  flag?: string;
  notes?: string;
  checkNumber?: string;
  ownerUserId?: string;
  businessSpaceId?: string;
  project?: string;
  taxCode?: string;
  receiptIds?: string[];
  scheduleId?: string;
  refundOfId?: string;
  importBatchId?: string;
  providerTransactionId?: string;
  clientOpId?: string;
  /** Set when an explicit FX conversion produced amountMinor. */
  fx?: { rate: string; rateDate: string; originalCurrency: string; originalAmountMinor: number };
  deleted?: boolean;
  excludeFromReports?: boolean;
  /** Present on records loaded from the API so an edit can detect a conflicting save. */
  version?: number;
}

export interface Assignment {
  id: string;
  bucketId: string;
  /** YYYY-MM */
  periodKey: string;
  amountMinor: number;
}

export interface Schedule {
  id: string;
  name: string;
  cadence: Cadence;
  customDays?: number;
  nextDate: string;
  amountMinor: number;
  /** Expected amount can be a range; amountMinor is the planning figure. */
  amountMaxMinor?: number;
  direction: "inflow" | "outflow";
  accountId?: string;
  bucketId?: string;
  type: "income" | "bill" | "subscription" | "transfer" | "fill" | "debt_payment";
  payee?: string;
  ownerUserId?: string;
  paused?: boolean;
  trialEnds?: string;
  renewalDate?: string;
  reminderDays?: number;
  /** When the occurrence was posted, skip it in the forecast. */
  fulfilledThrough?: string;
  confirmed?: boolean;
  detected?: boolean;
  /** Stored interval for every N days or weeks. customDays remains the day count used by monthly equivalents. */
  interval?: number;
  anchorDay?: number;
  twiceDayA?: number;
  twiceDayB?: number;
  endDate?: string;
  exceptionDates?: string[];
  reserved?: boolean;
  archived?: boolean;
  /** Set when the stored cadence is once, every N days, every N weeks, or irregular. */
  scheduleMode?: "once" | "every_n_days" | "every_n_weeks" | "irregular";
}

export interface PlanLine {
  id: string;
  bucketId: string;
  periodKey: string;
  plannedMinor: number;
}

export interface EngineInput {
  currency: string;
  asOf: string;
  /** Month being viewed, YYYY-MM. Defaults to asOf's month. */
  viewPeriod?: string;
  accounts: Account[];
  buckets: Bucket[];
  transactions: Transaction[];
  assignments: Assignment[];
  schedules?: Schedule[];
  planLines?: PlanLine[];
  includePending?: boolean;
  /** Rollover rules that take effect on and after effectivePeriod. Earlier boundaries keep the older rule. */
  rolloverPolicies?: RolloverPolicy[];
}

export interface RolloverPolicy {
  bucketId: string;
  /** Inclusive YYYY-MM. The carry out of this month uses this rule. */
  effectivePeriod: string;
  rollover: RolloverMode;
  rolloverCapMinor?: number;
}

export interface BucketMonth {
  bucketId: string;
  name: string;
  group: string;
  assignedMinor: number;
  activityOutMinor: number;
  activityInMinor: number;
  /** Net spending activity (out - in) for expenses. Income buckets report inflows separately. */
  activityMinor: number;
  availableMinor: number;
  creditOverspendMinor: number;
  rolloverInMinor: number;
  releasedMinor: number;
  funded: boolean;
}

export interface BudgetResult {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  readyToAssignMinor: number;
  futureAssignedMinor: number;
  cashPoolMinor: number;
  claimsMinor: number;
  identityDifferenceMinor: number;
  buckets: BucketMonth[];
  incomeMinor: number;
  spendingMinor: number;
  refundMinor: number;
  transferMinor: number;
  warnings: string[];
  cardGaps: { accountId: string; owedMinor: number; reservedMinor: number; gapMinor: number }[];
  borrowedFundsMinor: number;
}

export const IDENTITY_FORMULA =
  "On-budget cash = Ready to Assign + every bucket balance (including card-payment reserves and borrowed-funds parking) + cash reserved for future months. Credit-card debt that was never funded is not cash. Transfers between on-budget cash accounts do not change the total.";
