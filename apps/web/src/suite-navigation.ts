export const suiteGroups = [
  {name:"Everyday money", tools:[
    ["/","Home","Household dashboard and recent changes"],["/activity","Activity","Transactions, splits, matching and reconciliation"],["/plan","Budget plan","Categories, envelopes and assignments"],["/accounts","Accounts","Balances, transfers and account access"],["/receipts","Receipts","Scan and review receipts"],["/spending","Spending report","Categories, merchants and purchases"],
  ]},
  {name:"Assets & markets", tools:[
    ["/physical-assets","Physical assets","Inventory, photos, imports and resale values"],["/stocks-crypto/","Stocks & Crypto","Market Pulse charts, research, watchlists and paper trading"],["/wealth","Net worth","Assets, debts and household net worth"],["/investments","Investments","Holdings, lots and prices"],["/retirement","Retirement","Monthly projections and scenarios"],
  ]},
  {name:"Planning", tools:[
    ["/paychecks","Paychecks","Expected income and pay periods"],["/calendar","Calendar","Paychecks, bills and due dates"],["/bills","Bills","Recurring bills and subscriptions"],["/bills/import","Import bills","Preview and import bill records"],["/goals","Goals","Savings targets and envelopes"],["/debts","Debts","Loan, payment and refinance plans"],["/forecast","Forecast","Cash and paycheck projections"],["/catch-up","Paycheck catch-up","Overdue bills and installments"],["/alerts","Alerts","Upcoming bills and balance alerts"],
  ]},
  {name:"Reports & data", tools:[
    ["/reports","Reports","Spending, savings and exports"],["/statement-coverage","Statement coverage","Statement gaps and balance comparisons"],["/import","Import","Bank files, statement PDFs and merchant categories"],["/providers","Connections","Bank and other provider connections"],["/rules","Rules","Payee and category rules"],["/assistant","Assistant","Questions about your ledger"],
  ]},
  {name:"Household & settings", tools:[
    ["/household","Sharing","Household members, roles and spaces"],["/cases","Requests","Track outstanding requests"],["/credit","Credit","Track credit scores"],["/checklists","Checklists","Tax and estate tasks"],["/learn","Learn","Budgeting lessons"],["/help","Help","Find guidance for Budget HQ Pro"],["/setup","Setup","Household setup and onboarding"],["/settings","Settings","Security, appearance, backups and exports"],
  ]},
] as const;
export const mobileTabs = [["/","Home"],["/activity","Activity"],["/physical-assets","Assets"],["/stocks-crypto/","Markets"],["/more","All tools"]] as const;
