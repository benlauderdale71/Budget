export interface User {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  locale: string;
  timeZone: string;
  weekStart: number;
  theme: "light" | "dark" | "system";
  privacyMode: boolean;
  aiEnabled: boolean;
  payCadence: string;
  budgetApproach: string;
  labelMode: string;
  onboardingStep: string | null;
  dashboardLayout?: { id: string; hidden?: boolean }[];
}

export interface HouseholdRow {
  id: string;
  name: string;
  kind: string;
  currency: string;
  is_demo: number;
  budget_approach: string;
  label_mode: string;
  role: string;
}

export interface Space {
  id: string;
  name: string;
  kind: string;
}

export interface Bucket {
  id: string;
  name: string;
  group: string;
  kind: "income" | "expense";
  flexRole: string;
  envelopeStyle: string;
  rollover: string;
  systemRole?: string | null;
  purpose?: string;
  target?: { type: string; amountMinor: number; cadence: string; dueDate?: string };
  archived?: boolean;
}

export interface BucketMonth {
  bucketId: string;
  name: string;
  group: string;
  assignedMinor: number;
  activityMinor: number;
  availableMinor: number;
  creditOverspendMinor: number;
  funded: boolean;
}

export interface Budget {
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
  warnings: string[];
  cardGaps: { accountId: string; owedMinor: number; reservedMinor: number; gapMinor: number }[];
}

export interface Guidance {
  cashSafeMinor: number;
  shortageMinor: number;
  projectedAllowanceMinor: number;
  projectedUsesExpectedIncome: boolean;
  dailyCashMinor: number;
  daysRemaining: number;
  formula: string;
  lines: { label: string; amountMinor: number }[];
  primaryFigure: "cash" | "shortage";
}

export interface Account {
  id: string;
  spaceId: string;
  name: string;
  kind: string;
  currency: string;
  onBudget: boolean;
  visibility: string;
  hidden: boolean;
  archived: boolean;
  aprBps: number | null;
  minimumPaymentMinor: number | null;
  creditLimitMinor: number | null;
  mask: string | null;
  institution: string | null;
}

export interface Split {
  bucketId: string | null;
  amountMinor: number;
  role: string;
  memo?: string;
}

export interface Txn {
  id: string;
  date: string;
  accountId: string;
  counterAccountId?: string;
  amountMinor: number;
  currency: string;
  type: string;
  payee: string;
  notes?: string;
  splits: Split[];
  bankStatus: string;
  reviewStatus: string;
  cleared: boolean;
  reconciled: boolean;
  tags?: string[];
  version?: number;
  matchedArchivedId?: string | null;
  refundOfId?: string;
}

export interface Dashboard {
  household: {
    householdId: string;
    role: string;
    name: string;
    currency: string;
    isDemo: boolean;
    labelMode: string;
    budgetApproach: string;
    timeZone: string;
  };
  spaceId: string;
  spaces: Space[];
  accounts: Account[];
  buckets: Bucket[];
  budget: Budget;
  guidance: Guidance;
  ageOfMoney: { days: number | null; samples: number; formula: string };
  explain: { title: string; formula: string; lines: { label: string; amountMinor: number }[]; amountMinor: number };
  netWorth: {
    assetsMinor: number;
    liabilitiesMinor: number;
    netMinor: number;
    liquidMinor: number;
    formula: string;
    accounts: { accountId: string; name: string; displayMinor: number; contributionMinor: number; liquid: boolean }[];
  };
  upcoming: { id: string; date: string; amountMinor: number; label: string; kind: string; expectedIncome?: boolean }[];
  goals: { id: string; name: string; target_minor: number; target_date: string | null; availableMinor: number; bucket_id: string; purpose?: string }[];
  alerts: { id: string; title: string; body: string; kind: string; read_at: string | null; created_at: string }[];
  recent: Txn[];
  reviewCount: number;
}
