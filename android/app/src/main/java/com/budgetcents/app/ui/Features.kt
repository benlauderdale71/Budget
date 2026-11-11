package com.budgetcents.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.Locale

@Composable
fun FeatureScreen(
    page: String,
    api: BudgetApi,
    store: Store,
    dash: JSONObject?,
    privacy: Boolean,
    onBack: () -> Unit,
    onChanged: () -> Unit,
    onError: (String) -> Unit,
    onStatus: (String) -> Unit,
    onSignedOut: () -> Unit,
    onTheme: (String) -> Unit,
    onOpenTransactions: (String, String) -> Unit = { _, _ -> },
) {
    val hid = store.householdId ?: return
    val scope = rememberCoroutineScope()
    TextButton(onClick = onBack) { Text("Back") }
    Text(page.replaceFirstChar { it.titlecase() }, style = MaterialTheme.typography.headlineSmall)
    when (page) {
        "accounts" -> AccountsScreen(dash, privacy, onError) { name, kind, opening ->
            scope.launch {
                runIo(onError) {
                    api.request("POST", "/api/households/$hid/accounts", JSONObject()
                        .put("spaceId", dash?.optString("spaceId"))
                        .put("name", name)
                        .put("kind", kind)
                        .put("openingBalanceMinor", opening)
                        .put("openingDate", LocalDate.now().toString()))
                    onChanged()
                }
            }
        }
        "bills" -> BillsScreen(api, hid, dash, privacy, onError, onStatus, onChanged)
        "goals" -> {
            val goals = dash?.optJSONArray("goals") ?: JSONArray()
            if (goals.length() == 0) Text("A goal uses one envelope. The same dollars are not also free to spend.")
            for (index in 0 until goals.length()) {
                val goal = goals.getJSONObject(index)
                Text("${goal.optString("name")} ${money(goal.optLong("availableMinor"), privacy)} of ${money(goal.optLong("target_minor"), privacy)}")
            }
            BucketPick(dash, "expense") { bucketId, name, target ->
                scope.launch {
                    runIo(onError) {
                        api.request("POST", "/api/households/$hid/goals", JSONObject()
                            .put("spaceId", dash?.optString("spaceId")).put("name", name).put("bucketId", bucketId).put("targetMinor", target).put("purpose", "goal"))
                        onChanged()
                    }
                }
            }
        }
        "debts" -> DebtScreen(api, hid, privacy, onError, onStatus)
        "categories" -> CategoryScreen(api, hid, dash, privacy, onError, onStatus, onChanged)
        "fills" -> FillsScreen(api, hid, dash, privacy, onError, onStatus, onChanged)
        "paycheck" -> PaycheckScreen(api, hid, dash, privacy, onError, onStatus, onChanged)
        "calendar" -> CalendarScreen(api, hid, privacy, onError)
        "incomeplan" -> RemoteScreen("paycheck", { api.request("GET", "/api/households/$hid/income-plan?spaceId=${dash?.optString("spaceId") ?: ""}") }) { data ->
            Text(data.optString("note"))
            Text("Expected this period ${money(data.optLong("expectedIncomeMinor"), privacy)}")
            Text("Planned ${money(data.optLong("plannedMinor"), privacy)} · Still unplanned ${money(data.optLong("unplannedMinor"), privacy)}")
            val lines = data.optJSONArray("lines") ?: JSONArray()
            if (lines.length() == 0) Text("No paycheck allocations yet. This plan does not move money.")
            val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
            fun bucketName(id: String): String {
                for (index in 0 until buckets.length()) if (buckets.getJSONObject(index).optString("id") == id) return buckets.getJSONObject(index).optString("name")
                return "Category"
            }
            for (index in 0 until lines.length()) {
                val line = lines.getJSONObject(index)
                Text("${bucketName(line.optString("bucketId"))} ${money(line.optLong("plannedMinor"), privacy)}")
            }
            BucketPick(dash, "expense") { bucketId, _, target ->
                scope.launch {
                    runIo(onError) {
                        val next = org.json.JSONArray()
                        var replaced = false
                        for (index in 0 until lines.length()) {
                            val line = lines.getJSONObject(index)
                            val same = line.optString("bucketId") == bucketId
                            next.put(JSONObject().put("bucketId", line.optString("bucketId")).put("plannedMinor", if (same) target else line.optLong("plannedMinor")))
                            if (same) replaced = true
                        }
                        if (!replaced) next.put(JSONObject().put("bucketId", bucketId).put("plannedMinor", target))
                        val saved = api.request("PUT", "/api/households/$hid/income-plan", JSONObject()
                            .put("spaceId", data.optString("spaceId").ifBlank { dash?.optString("spaceId") })
                            .put("periodKey", data.optString("periodKey"))
                            .put("lines", next))
                        onStatus(saved.optString("note").ifBlank { "Paycheck plan saved." })
                        onChanged()
                    }
                }
            }
        }
        "forecast" -> {
            RemoteScreen("forecast", { api.request("GET", "/api/households/$hid/forecast?days=30") }) { data ->
            Text(data.optString("note"))
            val cash = data.optJSONObject("cash")
            Text("Cash ending ${money(cash?.optLong("endingMinor") ?: 0, privacy)}. Expected income is not spent in this figure.")
            val points = cash?.optJSONArray("points") ?: JSONArray()
            val step = (points.length() / 6).coerceAtLeast(1)
            for (index in 0 until points.length() step step) {
                val point = points.getJSONObject(index)
                Text("${point.optString("date")} ${money(point.optLong("balanceMinor"), privacy)}")
            }
            }
            ScenarioForm(onError) { name, label, amount, expense ->
                scope.launch {
                    runIo(onError) {
                        val result = api.request("POST", "/api/households/$hid/scenarios", JSONObject()
                            .put("spaceId", dash?.optString("spaceId"))
                            .put("name", name)
                            .put("days", 30)
                            .put("save", true)
                            .put("adjustments", org.json.JSONArray().put(JSONObject()
                                .put("id", java.util.UUID.randomUUID().toString())
                                .put("label", label)
                                .put("date", LocalDate.now().plusDays(7).toString())
                                .put("amountMinor", if (expense) -kotlin.math.abs(amount) else kotlin.math.abs(amount))
                                .put("kind", if (expense) "expense" else "income"))))
                        val ending = result.optJSONObject("projection")?.optLong("endingMinor") ?: 0
                        onStatus("${result.optString("note")} Ending cash ${money(ending, privacy)}.")
                    }
                }
            }
        }
        "investments" -> RemoteScreen("investments", { api.request("GET", "/api/households/$hid/investments") }) { data ->
            Text(data.optString("note"))
            val positions = data.optJSONArray("positions") ?: JSONArray()
            if (positions.length() == 0) Text("No holdings yet. A missing price stays missing.")
            for (index in 0 until positions.length()) {
                val row = positions.getJSONObject(index)
                val value = if (row.isNull("marketValueMinor")) "No price" else money(row.optLong("marketValueMinor"), privacy)
                Text("${row.optString("symbol")} ${row.optString("quoteSource")} $value")
            }
        }
        "retirement" -> RetirementScreen(onError) { age, portfolio, save, spend ->
            scope.launch {
                runIo(onError) {
                    val result = api.request("POST", "/api/households/$hid/retirement", JSONObject()
                        .put("currentAge", age).put("retireAge", 65).put("endAge", 90)
                        .put("portfolioMinor", portfolio).put("annualContributionMinor", save).put("annualSpendingMinor", spend)
                        .put("inflationBps", 250).put("meanReturnBps", 500).put("stdevBps", 1200).put("feeBps", 10).put("iterations", 200).put("seed", 1))
                    onStatus("Success rate ${(result.getJSONObject("result").optInt("successRateBps") / 100.0)}%. ${result.getJSONObject("result").optString("metric")}")
                }
            }
        }
        "reports" -> ReportScreen(api, hid, privacy, onError, onOpenTransactions)
        "rules" -> RemoteScreen("rules", { api.request("GET", "/api/households/$hid/rules") }) { data ->
            val rules = data.optJSONArray("rules") ?: JSONArray()
            if (rules.length() == 0) Text("No rules yet. A rule does not override a category you confirmed.")
            for (index in 0 until rules.length()) Text(rules.getJSONObject(index).optString("name"))
            RuleForm(onError) { name, payee ->
                scope.launch {
                    runIo(onError) {
                        api.request("POST", "/api/households/$hid/rules", JSONObject()
                            .put("spaceId", dash?.optString("spaceId"))
                            .put("name", name)
                            .put("priority", 50)
                            .put("matchMode", "all")
                            .put("conditions", org.json.JSONArray().put(JSONObject().put("field", "payee").put("op", "contains").put("value", payee)))
                            .put("actions", org.json.JSONArray().put(JSONObject().put("type", "set_reviewer"))))
                        onChanged()
                    }
                }
            }
        }
        "household" -> RemoteScreen("household", { api.request("GET", "/api/households/$hid/members") }) { data ->
            val members = data.optJSONArray("members") ?: JSONArray()
            for (index in 0 until members.length()) {
                val person = members.getJSONObject(index)
                Text("${person.optString("displayName")} · ${person.optString("role")}")
            }
            Text("Private accounts stay hidden from other members, including admins.")
            var email by remember { mutableStateOf("") }
            OutlinedTextField(email, { email = it }, label = { Text("Invite email") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = {
                scope.launch {
                    runIo(onError) {
                        val invite = api.request("POST", "/api/households/$hid/invitations", JSONObject().put("email", email.trim()).put("role", "editor"))
                        onStatus(invite.optString("summary"))
                    }
                }
            }) { Text("Create invite") }
        }
        "connections" -> RemoteScreen("connections", { api.request("GET", "/api/providers") }) { data ->
            Text("These services are not live. A stored request is not a completed cancellation, score, or transfer.")
            val providers = data.optJSONArray("providers") ?: JSONArray()
            for (index in 0 until providers.length()) {
                val provider = providers.getJSONObject(index)
                Text("${provider.optString("name")} · ${provider.optString("status")}")
                Text(provider.optString("needs"))
            }
        }
        "security" -> SecurityScreen(api, store, onTheme, onError, onSignedOut)
        "learn" -> RemoteScreen("learn", { api.request("GET", "/api/lessons") }) { data ->
            val lessons = data.optJSONArray("lessons") ?: JSONArray()
            for (index in 0 until lessons.length()) {
                val lesson = lessons.getJSONObject(index)
                Text(lesson.optString("title"), style = MaterialTheme.typography.titleMedium)
                Text(lesson.optString("body"))
                if (!lesson.optBoolean("completed")) {
                    TextButton(onClick = {
                        scope.launch { runIo(onError) { api.request("POST", "/api/lessons/${lesson.optString("id")}/complete", JSONObject()); onChanged() } }
                    }) { Text("Mark read") }
                }
            }
        }
        "assistant" -> AssistantScreen(onError) { question ->
            scope.launch {
                runIo(onError) {
                    val answer = api.request("POST", "/api/households/$hid/assistant", JSONObject().put("question", question))
                    onStatus(answer.optString("text"))
                }
            }
        }
        "import" -> ImportScreen(dash, onError) { text, accountId ->
            scope.launch {
                runIo(onError) {
                    val preview = api.request("POST", "/api/households/$hid/import/preview", JSONObject()
                        .put("spaceId", dash?.optString("spaceId")).put("format", "csv").put("text", text))
                    val rows = preview.optJSONArray("rows") ?: JSONArray()
                    val numbers = org.json.JSONArray()
                    for (index in 0 until rows.length()) if ((rows.getJSONObject(index).optJSONArray("errors")?.length() ?: 0) == 0) numbers.put(rows.getJSONObject(index).optInt("rowNumber"))
                    val committed = api.request("POST", "/api/households/$hid/import/${preview.optString("batchId")}/commit", JSONObject().put("accountId", accountId).put("rowNumbers", numbers))
                    onStatus("Imported ${committed.optInt("created")} rows. Review them before relying on the categories.")
                    onChanged()
                }
            }
        }
        else -> Text("That screen is not on this build.")
    }
}

@Composable
private fun DebtScreen(api: BudgetApi, hid: String, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit) {
    var strategy by remember { mutableStateOf("snowball") }
    Row {
        listOf("snowball", "avalanche").forEach { choice ->
            TextButton(onClick = { strategy = choice }) { Text(if (strategy == choice) choice.replaceFirstChar { it.titlecase() } else choice) }
        }
    }
    RemoteScreen(strategy, { api.request("GET", "/api/households/$hid/debts?strategy=$strategy") }) { data ->
        val assumptions = data.optJSONArray("assumptions")
        Text(if (assumptions != null && assumptions.length() > 0) assumptions.optString(0) else "This plan does not move money.")
        val debts = data.optJSONArray("debts") ?: JSONArray()
        if (debts.length() == 0) Text("Add a loan or card with a balance to build a payoff plan.")
        for (index in 0 until debts.length()) {
            val debt = debts.getJSONObject(index)
            Text("${debt.optString("name")} ${money(debt.optLong("balanceMinor"), privacy)} · APR ${"%.2f".format(Locale.US, debt.optInt("aprBps") / 100.0)}%")
        }
        val plan = data.optJSONObject("plan")
        if (plan != null && !plan.isNull("debtFreeDate")) Text("Debt-free date ${plan.optString("debtFreeDate")} · interest ${money(plan.optLong("totalInterestMinor"), privacy)}")
        else if (plan != null) Text("The model did not reach zero with these payments.")
    }
    LoanPlansScreen(api, hid, privacy, onError, onStatus)
}

private data class LoanEventDraft(val month: String = "1", val kind: String = "extra", val amount: String = "")

@Composable
private fun LoanPlansScreen(api: BudgetApi, hid: String, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableStateOf(0) }
    var catalog by remember { mutableStateOf<JSONObject?>(null) }
    var loadError by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("") }
    var planId by remember { mutableStateOf("") }
    var version by remember { mutableStateOf(0) }
    var name by remember { mutableStateOf("") }
    var accountId by remember { mutableStateOf("") }
    var balance by remember { mutableStateOf("") }
    var balanceDate by remember { mutableStateOf("") }
    var apr by remember { mutableStateOf("") }
    var payment by remember { mutableStateOf("") }
    var extra by remember { mutableStateOf("0.00") }
    var startDate by remember { mutableStateOf("") }
    var eventRows by remember { mutableStateOf(listOf<LoanEventDraft>()) }
    var refiMode by remember { mutableStateOf("payment") }
    var newApr by remember { mutableStateOf("") }
    var newPayment by remember { mutableStateOf("") }
    var term by remember { mutableStateOf("") }
    var upfront by remember { mutableStateOf("0.00") }
    var financed by remember { mutableStateOf("0.00") }
    var result by remember { mutableStateOf<JSONObject?>(null) }
    var exportText by remember { mutableStateOf("") }
    var cashAccountId by remember { mutableStateOf("") }
    var payPrincipal by remember { mutableStateOf("") }
    var payInterest by remember { mutableStateOf("") }
    var payFee by remember { mutableStateOf("") }
    LaunchedEffect(reload) {
        try {
            catalog = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/loan-scenarios") }
            loadError = ""
        } catch (caught: Exception) {
            loadError = caught.message ?: "Could not load loan plans."
        }
    }
    Text("Loan plans")
    Text("Saving or calculating a plan does not change the loan, cash, or Ready to Assign. Interest is a monthly approximation, not a lender payoff quote.")
    if (privacy) Text("Amounts are hidden. Show amounts before editing a plan.")
    if (catalog == null && loadError.isBlank()) Text("Loading…")
    if (loadError.isNotBlank()) Text(loadError)
    val loans = catalog?.optJSONArray("loans") ?: JSONArray()
    val scenarios = catalog?.optJSONArray("scenarios") ?: JSONArray()
    if (catalog != null && loans.length() == 0) Text("Add a loan account before saving a plan.")
    if (scenarios.length() == 0 && catalog != null) Text("No saved plans yet.")
    for (index in 0 until scenarios.length()) {
        val scenario = scenarios.getJSONObject(index)
        TextButton(onClick = {
            scope.launch {
                try {
                    val detail = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/loan-scenarios/${scenario.optString("id")}") }
                    kind = detail.optString("kind")
                    planId = detail.optString("id")
                    version = detail.optInt("version")
                    name = detail.optString("name")
                    accountId = detail.optString("accountId")
                    balanceDate = detail.optString("balanceDate")
                    startDate = detail.optString("startDate")
                    if (!privacy) {
                        balance = amountField(detail.optLong("balanceMinor"))
                        apr = "%.2f".format(Locale.US, detail.optInt("aprBps") / 100.0)
                        payment = amountField(detail.optLong("paymentMinor"))
                        extra = amountField(detail.optLong("extraMinor"))
                        val stored = detail.optJSONArray("events") ?: JSONArray()
                        val rows = mutableListOf<LoanEventDraft>()
                        for (eventIndex in 0 until stored.length()) {
                            val event = stored.getJSONObject(eventIndex)
                            val month = (event.optInt("monthIndex") + 1).toString()
                            rows += when {
                                event.optBoolean("holiday") -> LoanEventDraft(month, "holiday", "")
                                event.has("aprBps") -> LoanEventDraft(month, "rate", "%.2f".format(Locale.US, event.optInt("aprBps") / 100.0))
                                event.has("paymentMinor") -> LoanEventDraft(month, "payment", amountField(event.optLong("paymentMinor")))
                                else -> LoanEventDraft(month, "extra", amountField(event.optLong("extraOneTimeMinor")))
                            }
                        }
                        eventRows = rows
                        val refinance = detail.optJSONObject("refinance")
                        if (refinance != null && refinance.has("mode")) {
                            refiMode = refinance.optString("mode")
                            newApr = "%.2f".format(Locale.US, refinance.optInt("newAprBps") / 100.0)
                            newPayment = if (refinance.has("newPaymentMinor")) amountField(refinance.optLong("newPaymentMinor")) else ""
                            term = if (refinance.has("newTermMonths")) refinance.optInt("newTermMonths").toString() else ""
                            upfront = amountField(refinance.optLong("upfrontFeeMinor"))
                            financed = amountField(refinance.optLong("financedFeeMinor"))
                        }
                    }
                    result = detail
                } catch (caught: Exception) {
                    onError(caught.message ?: "Could not open that plan.")
                }
            }
        }) { Text(scenario.optString("name")) }
    }
    Row {
        Button(onClick = {
            kind = "extra"
            planId = ""
            version = 0
            name = ""
            eventRows = emptyList()
            result = null
            prefillLoan(loans, 0, privacy) { id, date, bal, rate, pay ->
                accountId = id
                balanceDate = date
                startDate = date
                if (!privacy) {
                    balance = bal
                    apr = rate
                    payment = pay
                }
            }
        }) { Text("New extra-payment plan") }
        Button(onClick = {
            kind = "refinance"
            planId = ""
            version = 0
            name = ""
            result = null
            prefillLoan(loans, 0, privacy) { id, date, bal, rate, pay ->
                accountId = id
                balanceDate = date
                startDate = date
                if (!privacy) {
                    balance = bal
                    apr = rate
                    payment = pay
                }
            }
        }) { Text("New refinance comparison") }
    }
    fun loanBody(): JSONObject {
        if (accountId.isBlank()) throw IllegalArgumentException("Choose a loan.")
        if (name.isBlank()) throw IllegalArgumentException("Name the plan.")
        val events = JSONArray()
        if (kind == "extra") {
            for (row in eventRows) {
                val month = row.month.toIntOrNull() ?: throw IllegalArgumentException("Event months start at 1.")
                if (month < 1) throw IllegalArgumentException("Event months start at 1.")
                val event = JSONObject().put("monthIndex", month - 1)
                when (row.kind) {
                    "holiday" -> event.put("holiday", true)
                    "rate" -> event.put("aprBps", percentBps(row.amount))
                    "payment" -> event.put("paymentMinor", parseDollars(row.amount))
                    else -> event.put("extraOneTimeMinor", parseDollars(row.amount))
                }
                events.put(event)
            }
        }
        val body = JSONObject()
            .put("accountId", accountId)
            .put("name", name.trim())
            .put("kind", kind)
            .put("balanceMinor", parseDollars(balance))
            .put("balanceDate", balanceDate)
            .put("aprBps", percentBps(apr))
            .put("paymentMinor", parseDollars(payment))
            .put("extraMinor", if (kind == "extra") parseDollars(extra.ifBlank { "0" }) else 0)
            .put("startDate", startDate.ifBlank { balanceDate })
            .put("frequency", "monthly")
            .put("interestMethod", "monthly_nominal")
            .put("events", events)
        if (planId.isNotBlank()) body.put("version", version)
        if (kind == "refinance") {
            val refinance = JSONObject()
                .put("mode", refiMode)
                .put("newAprBps", percentBps(newApr))
                .put("upfrontFeeMinor", parseDollars(upfront.ifBlank { "0" }))
                .put("financedFeeMinor", parseDollars(financed.ifBlank { "0" }))
            if (refiMode == "payment") refinance.put("newPaymentMinor", parseDollars(newPayment))
            else refinance.put("newTermMonths", term.toIntOrNull() ?: throw IllegalArgumentException("Enter the term in whole months."))
            body.put("refinance", refinance)
        }
        return body
    }
    if (kind.isNotBlank()) {
        Text(if (kind == "refinance") "Refinance comparison" else "Extra-payment plan")
        for (index in 0 until loans.length()) {
            val loan = loans.getJSONObject(index)
            TextButton(onClick = {
                if (planId.isNotBlank()) accountId = loan.optString("id")
                else prefillLoan(loans, index, privacy) { id, date, bal, rate, pay ->
                    accountId = id
                    balanceDate = date
                    startDate = date
                    if (!privacy) {
                        balance = bal
                        apr = rate
                        payment = pay
                    }
                }
            }) { Text(if (accountId == loan.optString("id")) "Selected ${loan.optString("name")}" else loan.optString("name")) }
        }
        if (!privacy) {
            OutlinedTextField(name, { name = it }, label = { Text("Plan name") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(balance, { balance = it }, label = { Text("Balance") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(apr, { apr = it }, label = { Text("APR percent") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(payment, { payment = it }, label = { Text("Payment") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            if (kind == "extra") {
                OutlinedTextField(extra, { extra = it }, label = { Text("Recurring extra") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                Text("Month 1 is the first payment. Extras in the same month are added. Two rates, or a holiday plus a payment, are rejected.")
                eventRows.forEachIndexed { index, row ->
                    OutlinedTextField(row.month, { value -> eventRows = eventRows.mapIndexed { rowIndex, item -> if (rowIndex == index) item.copy(month = value) else item } }, label = { Text("Event month") }, modifier = Modifier.fillMaxWidth())
                    ChoiceRow("Event", listOf("extra", "payment", "rate", "holiday"), row.kind) { selected ->
                        eventRows = eventRows.mapIndexed { rowIndex, item -> if (rowIndex == index) item.copy(kind = selected) else item }
                    }
                    if (row.kind != "holiday") {
                        OutlinedTextField(row.amount, { value -> eventRows = eventRows.mapIndexed { rowIndex, item -> if (rowIndex == index) item.copy(amount = value) else item } }, label = { Text(if (row.kind == "rate") "Event rate" else "Event amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                    }
                }
                TextButton(onClick = { eventRows = eventRows + LoanEventDraft() }) { Text("Add an event") }
            } else {
                ChoiceRow("Input mode", listOf("payment", "term"), refiMode) { refiMode = it }
                OutlinedTextField(newApr, { newApr = it }, label = { Text("Proposed APR") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                if (refiMode == "payment") {
                    OutlinedTextField(newPayment, { newPayment = it }, label = { Text("Proposed payment") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                } else {
                    OutlinedTextField(term, { term = it }, label = { Text("Term in months") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                }
                OutlinedTextField(upfront, { upfront = it }, label = { Text("Upfront fee") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(financed, { financed = it }, label = { Text("Financed fee") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
                Text("The upfront fee is paid now and is not added to the new principal. The financed fee is added once.")
            }
        }
        Row {
            TextButton(onClick = {
                scope.launch {
                    try {
                        val body = loanBody()
                        result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/loan-scenarios/preview", body) }
                        onStatus("Calculated. Nothing was saved.")
                    } catch (caught: Exception) {
                        onError(caught.message ?: "Check the amounts.")
                    }
                }
            }) { Text("Calculate") }
            Button(onClick = {
                scope.launch {
                    try {
                        val body = loanBody()
                        val saved = withContext(Dispatchers.IO) {
                            api.request(if (planId.isBlank()) "POST" else "PATCH", if (planId.isBlank()) "/api/households/$hid/loan-scenarios" else "/api/households/$hid/loan-scenarios/$planId", body)
                        }
                        planId = saved.optString("id")
                        version = saved.optInt("version")
                        result = saved
                        reload += 1
                        onStatus("Plan saved.")
                    } catch (caught: Exception) {
                        onError(caught.message ?: "Check the amounts.")
                    }
                }
            }) { Text("Save plan") }
            if (planId.isNotBlank()) {
                TextButton(onClick = {
                    scope.launch {
                        try {
                            val exported = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/loan-scenarios/$planId/export?format=json") }
                            exportText = exported.optString("csv").take(2000)
                            onStatus("Schedule exported.")
                        } catch (caught: Exception) {
                            onError(caught.message ?: "Could not export.")
                        }
                    }
                }) { Text("Export schedule") }
            }
        }
    }
    result?.let { view ->
        val snapshot = view.optJSONObject("snapshot")
        if (snapshot?.optBoolean("stale") == true) {
            Text(snapshot.optString("note"))
            Text("Ledger ${money(snapshot.optLong("ledgerBalanceMinor"), privacy)} as of ${snapshot.optString("ledgerAsOf")}. Saved snapshot ${money(view.optLong("balanceMinor"), privacy)}.")
            TextButton(onClick = {
                scope.launch {
                    try {
                        val refreshed = withContext(Dispatchers.IO) {
                            api.request("POST", "/api/households/$hid/loan-scenarios/$planId/refresh", JSONObject().put("version", version))
                        }
                        version = refreshed.optInt("version")
                        if (!privacy) balance = amountField(refreshed.optLong("balanceMinor"))
                        balanceDate = refreshed.optString("balanceDate")
                        result = refreshed
                        onStatus("Ledger balance copied into the plan.")
                    } catch (caught: Exception) {
                        onError(caught.message ?: "Could not refresh.")
                    }
                }
            }) { Text("Use the ledger balance") }
        } else if (snapshot != null) Text(snapshot.optString("note"))
        val baseline = view.optJSONObject("baseline")
        val scenario = view.optJSONObject("scenario")
        Text("Baseline")
        Text(scheduleLine(baseline, privacy))
        Text(if (view.optString("kind") == "refinance") "Proposed loan" else "This plan")
        Text(scheduleLine(scenario, privacy))
        val comparison = view.optJSONObject("comparison")
        if (comparison != null) {
            if (comparison.optBoolean("incomplete")) Text(comparison.optString("note"))
            else Text("Interest saved ${money(comparison.optLong("interestSavedMinor"), privacy)}. Time saved ${comparison.optInt("monthsSaved")} months.")
        }
        val refinance = view.optJSONObject("refinanceResult")
        if (refinance != null) {
            Text("Payment difference ${money(refinance.optLong("paymentDifferenceMinor"), privacy)}")
            Text("Upfront fee ${money(refinance.optLong("upfrontFeeMinor"), privacy)}. Financed fee ${money(refinance.optLong("financedFeeMinor"), privacy)}.")
            if (refinance.optBoolean("comparable") && !refinance.isNull("netBenefitMinor")) {
                val net = refinance.optLong("netBenefitMinor")
                Text(if (net >= 0) "Net modeled benefit ${money(net, privacy)}" else "Net modeled additional cost ${money(-net, privacy)}")
            } else Text("The interest totals are not compared because one side does not pay off within 100 years.")
            if (refinance.optBoolean("lowerPaymentCostsMore")) Text("The lower payment is not savings.")
            if (!refinance.isNull("breakEvenMonth")) Text("Break-even is month ${refinance.optInt("breakEvenMonth")} in this model.")
            Text("This comparison does not submit a loan application or refinance the loan.")
        }
        val months = scenario?.optJSONArray("months") ?: JSONArray()
        Text("Payment, interest, principal, extra, and remaining balance")
        val limit = minOf(12, months.length())
        for (index in 0 until limit) {
            val month = months.getJSONObject(index)
            Text("${month.optString("date")} pay ${money(month.optLong("paymentMinor"), privacy)} interest ${money(month.optLong("interestMinor"), privacy)} principal ${money(month.optLong("principalMinor"), privacy)} extra ${money(month.optLong("extraMinor"), privacy)} remaining ${money(month.optLong("balanceMinor"), privacy)}")
        }
        if (months.length() > limit) Text("${months.length() - limit} later payments are in the exported schedule.")
    }
    if (exportText.isNotBlank()) Text(exportText)
    if (planId.isNotBlank() && !privacy) {
        Text("Record an actual payment")
        Text("Posting a payment is separate from this plan. It does not reserve cash or mark a refinance complete. Principal is not a second expense.")
        val cash = catalog?.optJSONArray("cashAccounts") ?: JSONArray()
        for (index in 0 until cash.length()) {
            val account = cash.getJSONObject(index)
            TextButton(onClick = { cashAccountId = account.optString("id") }) {
                Text(if (cashAccountId == account.optString("id")) "Using ${account.optString("name")}" else account.optString("name"))
            }
        }
        OutlinedTextField(payPrincipal, { payPrincipal = it }, label = { Text("Principal") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(payInterest, { payInterest = it }, label = { Text("Interest") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(payFee, { payFee = it }, label = { Text("Fee") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        Button(onClick = {
            scope.launch {
                try {
                    if (cashAccountId.isBlank()) throw IllegalArgumentException("Choose the cash account.")
                    val body = JSONObject()
                        .put("cashAccountId", cashAccountId)
                        .put("date", LocalDate.now().toString())
                        .put("principalMinor", parseDollars(payPrincipal.ifBlank { "0" }))
                        .put("interestMinor", parseDollars(payInterest.ifBlank { "0" }))
                        .put("feeMinor", parseDollars(payFee.ifBlank { "0" }))
                        .put("opId", java.util.UUID.randomUUID().toString())
                    withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/loan-scenarios/$planId/record-payment", body) }
                    onStatus("Payment posted.")
                    reload += 1
                } catch (caught: Exception) {
                    onError(caught.message ?: "That payment was not recorded.")
                }
            }
        }) { Text("Post payment") }
    }
}

private fun prefillLoan(loans: JSONArray, index: Int, privacy: Boolean, apply: (String, String, String, String, String) -> Unit) {
    if (loans.length() == 0) return
    val loan = loans.getJSONObject(index)
    apply(
        loan.optString("id"),
        loan.optString("balanceDate"),
        if (privacy) "" else amountField(loan.optLong("balanceMinor")),
        if (privacy) "" else "%.2f".format(Locale.US, loan.optInt("aprBps") / 100.0),
        if (privacy) "" else amountField(loan.optLong("paymentMinor")),
    )
}

private fun scheduleLine(schedule: JSONObject?, privacy: Boolean): String {
    if (schedule == null) return "No schedule."
    if (!schedule.optBoolean("paidOff")) return "Not paid off within 100 years. This is not a finished payoff."
    return "Payoff ${schedule.optString("payoffDate")} · ${schedule.optInt("payoffMonths")} payments · interest ${money(schedule.optLong("totalInterestMinor"), privacy)}"
}

@Composable
private fun AccountsScreen(dash: JSONObject?, privacy: Boolean, onError: (String) -> Unit, onCreate: (String, String, Long) -> Unit) {
    val accounts = dash?.optJSONArray("accounts") ?: JSONArray()
    if (accounts.length() == 0) Text("No accounts yet.")
    for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        Text("${account.optString("name")} · ${account.optString("kind")}")
    }
    var name by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("checking") }
    var opening by remember { mutableStateOf("") }
    OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
    Row {
        listOf("checking", "savings", "cash", "credit", "loan").forEach { choice ->
            TextButton(onClick = { kind = choice }) { Text(if (kind == choice) choice.replaceFirstChar { it.titlecase() } else choice) }
        }
    }
    OutlinedTextField(opening, { opening = it }, label = { Text("Opening balance") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        if (name.isBlank()) onError("Name the account.") else onCreate(name, kind, if (opening.isBlank()) 0 else parseDollars(opening))
    }) { Text("Add account") }
    if (privacy) Text("Amounts in the rest of the app are hidden on this device.")
}

@Composable
private fun CategoryScreen(api: BudgetApi, hid: String, dash: JSONObject?, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    val period = dash?.optJSONObject("budget")?.optString("periodKey") ?: java.time.LocalDate.now().toString().take(7)
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    BackHandler(enabled = editing != null) { editing = null }
    val funding = dash?.optJSONObject("funding")
    if (funding != null) Text("Eligible posted income ${money(funding.optLong("eligiblePostedIncomeMinor"), privacy)}. ${funding.optString("formula")}")
    if (editing == null) {
        if (buckets.length() == 0) Text("No categories yet.")
        for (index in 0 until buckets.length()) {
            val bucket = buckets.getJSONObject(index)
            if (bucket.optString("systemRole").isNotBlank() || bucket.optBoolean("archived")) continue
            val style = bucket.optString("envelopeStyle").ifBlank { "regular" }
            Text("${bucket.optString("name")} · ${bucket.optString("kind")} · ${bucket.optString("flexRole").ifBlank { "flexible" }} · $style")
            TextButton(onClick = { editing = bucket }) { Text("Edit ${bucket.optString("name")}") }
        }
        CategoryForm(null, period, privacy, onError, null) { body ->
            scope.launch {
                try {
                    body.put("spaceId", dash?.optString("spaceId"))
                    withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/buckets", body) }
                    onStatus("Category saved. Nothing was assigned.")
                    onChanged()
                } catch (caught: Exception) {
                    onError(caught.message ?: "Could not save the category.")
                }
            }
        }
    } else {
        val current = editing ?: return
        Text("Editing ${current.optString("name")}. Version ${current.optInt("version", 1)}.")
        val progress = funding?.optJSONArray("buckets")
        if (progress != null) {
            for (index in 0 until progress.length()) {
                val row = progress.getJSONObject(index)
                if (row.optString("bucketId") == current.optString("id") && row.optInt("percentBps", -1) >= 0) {
                    Text("Eligible ${money(funding.optLong("eligiblePostedIncomeMinor"), privacy)} · ${row.optString("percentLabel")} · target ${money(row.optLong("targetMinor"), privacy)} · funded ${money(row.optLong("fundedMinor"), privacy)} · still needed ${money(row.optLong("shortfallMinor"), privacy)}")
                }
            }
        }
        CategoryForm(current, period, privacy, onError, { body, done ->
            scope.launch {
                try {
                    val result = withContext(Dispatchers.IO) { api.request("PATCH", "/api/households/$hid/buckets/${current.optString("id")}", body) }
                    val thisMonth = result.optJSONObject("thisMonth")?.optLong("readyDeltaMinor") ?: 0
                    val nextMonth = result.optJSONObject("nextMonth")?.optLong("readyDeltaMinor") ?: 0
                    done("Preview only. No money moved. This month Ready to Assign changes by ${money(thisMonth, privacy)}. Next month changes by ${money(nextMonth, privacy)}. ${result.optString("effect")}")
                } catch (caught: Exception) {
                    onError(caught.message ?: "Could not preview the rollover.")
                }
            }
        }) { body ->
            scope.launch {
                try {
                    withContext(Dispatchers.IO) { api.request("PATCH", "/api/households/$hid/buckets/${current.optString("id")}", body) }
                    onStatus("Category saved. No money was moved.")
                    editing = null
                    onChanged()
                } catch (caught: Exception) {
                    onError(caught.message ?: "Could not save the category.")
                }
            }
        }
    }
    Text("A category and an envelope are views of the same money. Editing a target does not assign cash. A percent uses posted income only.")
}

@Composable
private fun CategoryForm(existing: JSONObject?, period: String, privacy: Boolean, onError: (String) -> Unit, onPreview: ((JSONObject, (String) -> Unit) -> Unit)?, onSave: (JSONObject) -> Unit) {
    val target = existing?.optJSONObject("target")
    var name by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("name") ?: "") }
    var group by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("group") ?: "Spending") }
    var icon by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("icon") ?: "") }
    var order by remember(existing?.optString("id")) { mutableStateOf((existing?.optInt("displayOrder") ?: 0).toString()) }
    var kind by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("kind")?.ifBlank { "expense" } ?: "expense") }
    var role by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("flexRole")?.ifBlank { "flexible" } ?: "flexible") }
    var style by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("envelopeStyle")?.ifBlank { "regular" } ?: "regular") }
    var rollover by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("displayRollover")?.ifBlank { existing.optString("rollover").ifBlank { "both" } } ?: "both") }
    var cap by remember(existing?.optString("id")) { mutableStateOf("") }
    var targetType by remember(existing?.optString("id")) { mutableStateOf(target?.optString("type")?.ifBlank { "none" } ?: "none") }
    var targetAmount by remember(existing?.optString("id")) { mutableStateOf(if (target == null) "" else amountField(target.optLong("amountMinor"))) }
    var recalculate by remember(existing?.optString("id")) { mutableStateOf(false) }
    var sawPreview by remember(existing?.optString("id")) { mutableStateOf(false) }
    var previewNote by remember(existing?.optString("id")) { mutableStateOf("") }
    var percent by remember(existing?.optString("id")) { mutableStateOf(if (target?.has("percentBps") == true) (target.optInt("percentBps") / 100.0).toString() else "") }
    var due by remember(existing?.optString("id")) { mutableStateOf(target?.optString("dueDate") ?: "") }
    var paused by remember(existing?.optString("id")) { mutableStateOf(target?.optString("pausedUntil") ?: "") }
    var effective by remember(existing?.optString("id")) { mutableStateOf(existing?.optString("rolloverEffectivePeriod")?.ifBlank { period } ?: period) }
    var archived by remember(existing?.optString("id")) { mutableStateOf(existing?.optBoolean("archived") ?: false) }
    OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(group, { group = it }, label = { Text("Group") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(icon, { icon = it }, label = { Text("Icon") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(order, { order = it }, label = { Text("Display order") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
    ChoiceRow("Kind", listOf("expense", "income"), kind) { kind = it }
    ChoiceRow("Classification", listOf("fixed", "non_monthly", "flexible"), role) { role = it }
    ChoiceRow("Style", listOf("regular", "annual", "goal", "debt"), style) { style = it }
    ChoiceRow("Rollover", listOf("both", "positive", "negative", "none", "capped"), rollover) { rollover = it }
    OutlinedTextField(cap, { cap = it }, label = { Text("Rollover cap") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(effective, { effective = it }, label = { Text("Effective month YYYY-MM") }, modifier = Modifier.fillMaxWidth())
    Text(if (privacy) "Amounts on this screen are hidden." else "A rollover change applies when that month closes. Earlier months stay put unless you preview a recalculation and then confirm it.")
    if (existing != null) {
        TextButton(onClick = { recalculate = !recalculate; sawPreview = false }) { Text(if (recalculate) "Recalculate earlier months: on" else "Recalculate earlier months: off") }
        if (recalculate && onPreview != null) {
            Button(onClick = {
                val body = categoryBody(existing, name, group, icon, order, kind, role, style, rollover, cap, effective, period, archived, targetType, targetAmount, percent, due, paused, true, true, onError) ?: return@Button
                onPreview(body) { message -> previewNote = message; sawPreview = true }
            }) { Text("Preview rollover change") }
        }
        if (previewNote.isNotBlank()) Text(previewNote)
    }
    ChoiceRow("Target", listOf("none", "refill", "set_aside", "balance_by_date", "maintain_balance", "debt_payment"), targetType) { targetType = it }
    OutlinedTextField(targetAmount, { targetAmount = it }, label = { Text("Target amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(percent, { percent = it }, label = { Text("Percent of eligible posted income") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(due, { due = it }, label = { Text("Target date") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(paused, { paused = it }, label = { Text("Pause until YYYY-MM-DD") }, modifier = Modifier.fillMaxWidth())
    if (existing != null) TextButton(onClick = { archived = !archived }) { Text(if (archived) "Archived — tap to restore" else "Archive this category") }
    Button(onClick = {
        if (recalculate && !sawPreview) { onError("Preview the recalculation before saving it."); return@Button }
        val body = categoryBody(existing, name, group, icon, order, kind, role, style, rollover, cap, effective, period, archived, targetType, targetAmount, percent, due, paused, recalculate && sawPreview, false, onError) ?: return@Button
        onSave(body)
    }) { Text(if (existing == null) "Add category" else if (recalculate) "Save recalculation" else "Save category") }
}

private fun categoryBody(
    existing: JSONObject?,
    name: String,
    group: String,
    icon: String,
    order: String,
    kind: String,
    role: String,
    style: String,
    rollover: String,
    cap: String,
    effective: String,
    period: String,
    archived: Boolean,
    targetType: String,
    targetAmount: String,
    percent: String,
    due: String,
    paused: String,
    recalculate: Boolean,
    preview: Boolean,
    onError: (String) -> Unit,
): JSONObject? {
    return try {
        if (name.isBlank()) { onError("Name the category."); return null }
        val body = JSONObject()
            .put("name", name.trim())
            .put("group", group.ifBlank { "Spending" })
            .put("displayOrder", order.toIntOrNull() ?: 0)
            .put("kind", kind)
            .put("flexRole", role)
            .put("envelopeStyle", style)
            .put("rollover", rollover)
            .put("archived", archived)
            .put("effectivePeriod", effective.ifBlank { period })
            .put("recalculate", recalculate)
            .put("preview", preview)
        if (icon.isNotBlank()) body.put("icon", icon) else if (existing != null) body.put("icon", JSONObject.NULL)
        if (rollover == "capped") body.put("rolloverCapMinor", parseDollars(cap.ifBlank { "0" }))
        if (existing != null) body.put("version", existing.optInt("version", 1))
        if (targetType == "none") body.put("target", JSONObject.NULL) else {
            val targetBody = JSONObject().put("type", targetType).put("amountMinor", parseDollars(targetAmount.ifBlank { "0" })).put("cadence", "monthly")
            if (due.isNotBlank()) targetBody.put("dueDate", due)
            if (paused.isNotBlank()) targetBody.put("pausedUntil", paused)
            if (percent.isNotBlank()) targetBody.put("percentBps", percentBps(percent))
            body.put("target", targetBody)
        }
        body
    } catch (caught: Exception) {
        onError(caught.message ?: "Check the amounts and percent.")
        null
    }
}

@Composable
private fun ChoiceRow(label: String, choices: List<String>, selected: String, onSelect: (String) -> Unit) {
    Text(label)
    Row {
        choices.forEach { choice ->
            TextButton(onClick = { onSelect(choice) }) { Text(if (choice == selected) choice.replace('_', ' ').replaceFirstChar { it.titlecase() } else choice.replace('_', ' ')) }
        }
    }
}

@Composable
private fun FillsScreen(api: BudgetApi, hid: String, dash: JSONObject?, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var creating by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf<JSONArray?>(null) }
    BackHandler(enabled = editing != null || creating) { editing = null; creating = false }
    Text("A fill assigns cash already in the budget. It is not a bank transfer. Saved and Scheduled are not the same as Applied.")
    if (privacy) Text("Amounts are hidden on this device.")
    RemoteScreen("fills-$reload", { api.request("GET", "/api/households/$hid/fills") }) { data ->
        Text(data.optString("note"))
        val fills = data.optJSONArray("fills") ?: JSONArray()
        if (fills.length() == 0) Text("No saved fills yet.")
        for (index in 0 until fills.length()) {
            val fill = fills.getJSONObject(index)
            Text("${fill.optString("name")} · ${fill.optString("statusLabel")} · next ${fill.optString("nextDate").ifBlank { "none" }}")
            val last = fill.optJSONObject("lastOutcome")
            if (last == null) Text("No occurrence has run.") else Text("Last result ${last.optString("statusLabel")} ${money(last.optLong("allocatedMinor"), privacy)}")
            Row {
                TextButton(onClick = { fillAction(scope, api, hid, fill.optString("id"), "run", onError, onStatus) { reload += 1; onChanged() } }) { Text("Run now") }
                TextButton(onClick = { fillAction(scope, api, hid, fill.optString("id"), "skip", onError, onStatus) { reload += 1; onChanged() } }) { Text("Skip") }
                TextButton(onClick = {
                    val action = if (fill.optString("statusLabel") == "Paused") "resume" else "pause"
                    fillAction(scope, api, hid, fill.optString("id"), action, onError, onStatus) { reload += 1; onChanged() }
                }) { Text(if (fill.optString("statusLabel") == "Paused") "Resume" else "Pause") }
                TextButton(onClick = { editing = fill; creating = false; history = null }) { Text("Edit") }
                TextButton(onClick = {
                    scope.launch {
                        try {
                            val rows = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/fills/${fill.optString("id")}/history") }
                            history = rows.optJSONArray("history") ?: JSONArray()
                        } catch (caught: Exception) {
                            onError(caught.message ?: "Could not load fill history.")
                        }
                    }
                }) { Text("History") }
            }
        }
    }
    if (history != null) {
        val rows = history ?: JSONArray()
        if (rows.length() == 0) Text("No history yet.")
        for (index in 0 until rows.length()) {
            val row = rows.getJSONObject(index)
            val explanation = row.optJSONObject("detail")?.optString("explanation").orEmpty()
            Text("${row.optString("date")} ${row.optString("statusLabel")}. Allocated ${money(row.optLong("allocatedMinor"), privacy)}. Short ${money(row.optLong("shortfallMinor"), privacy)}. $explanation")
        }
    }
    if (editing != null || creating) {
        FillForm(dash, if (creating) null else editing, privacy, onError, { body, done ->
            scope.launch {
                try {
                    val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/fills/preview", body) }
                    val plan = result.optJSONObject("plan")
                    done(if (plan == null) result.optString("note") else "Preview only. No money moved. Ready to Assign ${money(plan.optLong("readyBeforeMinor"), privacy)} becomes ${money(plan.optLong("readyAfterMinor"), privacy)}. Allocated ${money(plan.optLong("totalAllocatedMinor"), privacy)}. Short ${money(plan.optLong("shortfallMinor"), privacy)}. ${plan.optString("explanation")}")
                } catch (caught: Exception) {
                    onError(caught.message ?: "Could not preview the fill.")
                }
            }
        }) { body ->
            scope.launch {
                try {
                    val current = editing
                    withContext(Dispatchers.IO) {
                        if (current == null) api.request("POST", "/api/households/$hid/fills", body)
                        else api.request("PATCH", "/api/households/$hid/fills/${current.optString("id")}", body)
                    }
                    onStatus(if (current == null) "Fill saved. It has not moved any money." else "Fill updated. Past results were kept, and no money moved.")
                    editing = null
                    creating = false
                    reload += 1
                    onChanged()
                } catch (caught: Exception) {
                    onError(caught.message ?: "Could not save the fill.")
                }
            }
        }
    } else {
        Button(onClick = { creating = true; history = null }) { Text("New fill") }
    }
}

private fun fillAction(scope: kotlinx.coroutines.CoroutineScope, api: BudgetApi, hid: String, id: String, action: String, onError: (String) -> Unit, onStatus: (String) -> Unit, onDone: () -> Unit) {
    scope.launch {
        try {
            val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/fills/$id/$action", JSONObject()) }
            onStatus(result.optString("statusLabel").ifBlank { "Saved" } + ". " + result.optString("explanation").ifBlank { result.optString("note") })
            onDone()
        } catch (caught: Exception) {
            onError(caught.message ?: "Could not update the fill.")
        }
    }
}

private data class AndroidFillLine(val bucketId: String, val mode: String, val amount: String, val priority: String, val sourceId: String)

@Composable
private fun FillForm(dash: JSONObject?, existing: JSONObject?, privacy: Boolean, onError: (String) -> Unit, onPreview: (JSONObject, (String) -> Unit) -> Unit, onSave: (JSONObject) -> Unit) {
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    val choices = (0 until buckets.length()).map { buckets.getJSONObject(it) }.filter { it.optString("systemRole").isBlank() && !it.optBoolean("archived") && it.optString("kind") == "expense" }
    val key = existing?.optString("id") ?: "new"
    var name by remember(key) { mutableStateOf(existing?.optString("name")?.ifBlank { "Payday fill" } ?: "Payday fill") }
    var cadence by remember(key) { mutableStateOf(existing?.optString("cadence")?.ifBlank { "monthly" } ?: "monthly") }
    var customDays by remember(key) { mutableStateOf(if (existing?.has("customDays") == true && !existing.isNull("customDays")) existing.optInt("customDays").toString() else "") }
    var startDate by remember(key) { mutableStateOf(existing?.optString("startDate")?.ifBlank { LocalDate.now().toString() } ?: LocalDate.now().toString()) }
    var endDate by remember(key) { mutableStateOf(existing?.optString("endDate") ?: "") }
    var policy by remember(key) { mutableStateOf(existing?.optString("shortfallPolicy")?.ifBlank { "partial" } ?: "partial") }
    var sweep by remember(key) { mutableStateOf(existing?.optString("sweepBucketId") ?: "") }
    var paused by remember(key) { mutableStateOf(existing?.optBoolean("paused") ?: false) }
    var previewNote by remember(key) { mutableStateOf("") }
    val lines = remember(key) {
        val seed = mutableStateListOf<AndroidFillLine>()
        val stored = existing?.optJSONArray("lines")
        if (stored == null || stored.length() == 0) {
            seed.add(AndroidFillLine(choices.firstOrNull()?.optString("id") ?: "", "add", "", "1", ""))
        } else {
            for (index in 0 until stored.length()) {
                val line = stored.getJSONObject(index)
                val amount = when (line.optString("mode")) {
                    "percent" -> if (line.has("percentBps") && !line.isNull("percentBps")) (line.optInt("percentBps") / 100.0).toString() else ""
                    "shortfall" -> ""
                    else -> if (line.has("amountMinor") && !line.isNull("amountMinor")) amountField(line.optLong("amountMinor")) else ""
                }
                seed.add(AndroidFillLine(line.optString("bucketId"), line.optString("mode").ifBlank { "add" }, amount, line.optInt("priority", index + 1).toString(), line.optString("sourceBucketId")))
            }
        }
        seed
    }
    Text(if (existing == null) "New fill" else "Edit ${existing.optString("name")}")
    Text("Saving does not move money and does not rerun a date that already has a result. If this fill has never run, the next date becomes the start date. If it has run, the next date stays unless it is earlier than the new start date.")
    if (privacy) Text("Preview and history amounts are hidden.")
    OutlinedTextField(name, { name = it }, label = { Text("Fill name") }, modifier = Modifier.fillMaxWidth())
    ChoiceRow("Schedule", listOf("once", "weekly", "biweekly", "twice_monthly", "monthly", "every_2_months", "every_3_months", "every_6_months", "annual", "custom"), cadence) { cadence = it }
    if (cadence == "custom") OutlinedTextField(customDays, { customDays = it }, label = { Text("Custom days") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(startDate, { startDate = it }, label = { Text("Start YYYY-MM-DD") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(endDate, { endDate = it }, label = { Text("End YYYY-MM-DD, optional") }, modifier = Modifier.fillMaxWidth())
    ChoiceRow("If cash is short", listOf("partial", "skip"), policy) { policy = it }
    Text(if (policy == "skip") "The whole occurrence is skipped when cash is short." else "Envelopes are funded in priority order until Ready to Assign runs out.")
    Text("Sweep leftover Ready to Assign")
    Row {
        TextButton(onClick = { sweep = "" }) { Text(if (sweep.isBlank()) "No sweep" else "Clear sweep") }
        choices.forEach { choice -> TextButton(onClick = { sweep = choice.optString("id") }) { Text(if (sweep == choice.optString("id")) "Sweep ${choice.optString("name")}" else choice.optString("name")) } }
    }
    TextButton(onClick = { paused = !paused }) { Text(if (paused) "Paused" else "Not paused") }
    lines.forEachIndexed { index, line ->
        Text("Envelope ${index + 1}")
        Row { choices.forEach { choice -> TextButton(onClick = { lines[index] = line.copy(bucketId = choice.optString("id")) }) { Text(if (line.bucketId == choice.optString("id")) "Selected ${choice.optString("name")}" else choice.optString("name")) } } }
        ChoiceRow("Action ${index + 1}", listOf("add", "top_up", "shortfall", "percent"), line.mode) { lines[index] = line.copy(mode = it) }
        if (line.mode != "shortfall") OutlinedTextField(line.amount, { lines[index] = line.copy(amount = it) }, label = { Text(if (line.mode == "percent") "Percent" else "Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(line.priority, { lines[index] = line.copy(priority = it) }, label = { Text("Priority") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
        Text("Take the money from")
        Row {
            TextButton(onClick = { lines[index] = line.copy(sourceId = "") }) { Text(if (line.sourceId.isBlank()) "Ready to Assign" else "Use Ready to Assign") }
            choices.forEach { choice -> TextButton(onClick = { lines[index] = line.copy(sourceId = choice.optString("id")) }) { Text(if (line.sourceId == choice.optString("id")) "From ${choice.optString("name")}" else choice.optString("name")) } }
        }
        Row {
            TextButton(onClick = { if (index > 0) { val previous = lines[index - 1]; lines[index - 1] = lines[index].copy(priority = previous.priority); lines[index] = previous.copy(priority = lines[index].priority) } }) { Text("Move up") }
            TextButton(onClick = { if (index < lines.lastIndex) { val next = lines[index + 1]; lines[index + 1] = lines[index].copy(priority = next.priority); lines[index] = next.copy(priority = lines[index].priority) } }) { Text("Move down") }
            TextButton(onClick = { if (lines.size > 1) lines.removeAt(index) }) { Text("Remove envelope") }
        }
    }
    TextButton(onClick = { lines.add(AndroidFillLine("", "add", "", (lines.size + 1).toString(), "")) }) { Text("Add envelope") }
    if (previewNote.isNotBlank()) Text(previewNote)
    Row {
        Button(onClick = {
            val body = fillBody(dash, existing, name, cadence, customDays, startDate, endDate, policy, sweep, paused, lines, onError) ?: return@Button
            onPreview(body) { previewNote = it }
        }) { Text("Preview") }
        Button(onClick = {
            val body = fillBody(dash, existing, name, cadence, customDays, startDate, endDate, policy, sweep, paused, lines, onError) ?: return@Button
            onSave(body)
        }) { Text(if (existing == null) "Save fill" else "Save edit") }
    }
}

private fun fillBody(dash: JSONObject?, existing: JSONObject?, name: String, cadence: String, customDays: String, startDate: String, endDate: String, policy: String, sweep: String, paused: Boolean, lines: List<AndroidFillLine>, onError: (String) -> Unit): JSONObject? {
    return try {
        val payload = JSONArray()
        lines.filter { it.bucketId.isNotBlank() }.forEachIndexed { index, line ->
            val row = JSONObject().put("bucketId", line.bucketId).put("mode", line.mode).put("priority", line.priority.toIntOrNull() ?: index + 1)
            if (line.sourceId.isNotBlank()) row.put("sourceBucketId", line.sourceId)
            if (line.mode == "percent") row.put("percentBps", percentBps(line.amount))
            else if (line.mode != "shortfall") row.put("amountMinor", parseDollars(line.amount.ifBlank { "0" }))
            payload.put(row)
        }
        if (payload.length() == 0) { onError("Choose an envelope."); return null }
        val body = JSONObject()
            .put("spaceId", dash?.optString("spaceId"))
            .put("name", name)
            .put("cadence", cadence)
            .put("startDate", startDate)
            .put("shortfallPolicy", policy)
            .put("paused", paused)
            .put("lines", payload)
        if (cadence == "custom") body.put("customDays", customDays.toInt())
        if (endDate.isNotBlank()) body.put("endDate", endDate)
        if (sweep.isNotBlank()) body.put("sweepBucketId", sweep)
        if (existing != null) body.put("version", existing.optInt("version", 1))
        body
    } catch (caught: Exception) {
        onError(caught.message ?: "Check the amounts.")
        null
    }
}

@Composable
private fun ScenarioForm(onError: (String) -> Unit, onSave: (String, String, Long, Boolean) -> Unit) {
    var name by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var expense by remember { mutableStateOf(true) }
    Text("What-if")
    OutlinedTextField(name, { name = it }, label = { Text("Scenario name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(label, { label = it }, label = { Text("Label") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Row {
        TextButton(onClick = { expense = true }) { Text(if (expense) "Expense" else "Make it an expense") }
        TextButton(onClick = { expense = false }) { Text(if (!expense) "Income" else "Make it income") }
    }
    Button(onClick = {
        val parsed = runCatching { parseDollars(amount) }.getOrNull()
        if (name.isBlank() || label.isBlank() || parsed == null) onError("Name the scenario and enter an amount like 12.50.")
        else onSave(name, label, parsed, expense)
    }) { Text("Save scenario") }
    Text("Saving a scenario does not change accounts or the budget.")
}

@Composable
private fun PaycheckScreen(api: BudgetApi, hid: String, dash: JSONObject?, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableStateOf(0) }
    var scenario by remember { mutableStateOf("expected") }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var openId by remember { mutableStateOf("") }
    Text("Expected pay is not cash, Ready to Assign, or net worth. A short month does not permanently move an anchored day.")
    if (privacy) Text("Amounts are hidden on this device.")
    Row {
        listOf("conservative", "expected", "optimistic").forEach { choice ->
            TextButton(onClick = { scenario = choice; reload += 1 }) { Text(if (choice == scenario) choice.replaceFirstChar { it.titlecase() } else choice) }
        }
    }
    RemoteScreen("paychecks-$reload-$scenario", {
        val plan = api.request("GET", "/api/households/$hid/paychecks?scenario=$scenario")
        val listed = api.request("GET", "/api/households/$hid/income-sources?archived=1")
        plan.put("archivedSources", listed.optJSONArray("archived") ?: JSONArray())
        plan
    }) { data ->
        val actual = data.optJSONObject("actual")
        Text("Cash on hand ${money(actual?.optLong("cashMinor") ?: 0, privacy)}")
        Text("Ready to Assign ${money(actual?.optLong("readyToAssignMinor") ?: 0, privacy)}")
        Text("Received so far ${money(data.optLong("receivedSoFarMinor"), privacy)}")
        Text("Projected cash ${money(data.optLong("projectedCashMinor"), privacy)}. If expected pay arrives ${money(data.optLong("projectedWithExpectedMinor"), privacy)}. The second figure is not money you can assign.")
        val states = data.optJSONObject("states")
        if (states?.optBoolean("empty") == true) Text("No income sources yet.")
        if (states?.optBoolean("missing") == true && states.optBoolean("empty") != true) Text("No paycheck is expected in this window.")
        if ((states?.optInt("overdue") ?: 0) > 0) Text("Overdue expected pay is still not cash.")
        if ((states?.optInt("delayed") ?: 0) > 0) Text("Delayed paychecks stay expected until you record them.")
        val sources = data.optJSONArray("sources") ?: JSONArray()
        for (index in 0 until sources.length()) {
            val source = sources.getJSONObject(index)
            Text("${source.optString("name")} · ${source.optString("cadence")} · ${money(source.optLong("amountMinor"), privacy)}${if (source.optBoolean("paused")) " · Paused" else ""}")
            if (source.optString("notes").isNotBlank()) Text(source.optString("notes"))
            Row {
                TextButton(onClick = { openId = source.optString("id") }) { Text("Open") }
                TextButton(onClick = { editing = JSONObject(source.toString()); openId = "" }) { Text("Edit") }
                TextButton(onClick = {
                    scope.launch {
                        runIo(onError) {
                            api.request("POST", "/api/households/$hid/income-sources/${source.optString("id")}/${if (source.optBoolean("paused")) "resume" else "pause"}", JSONObject().put("version", source.optInt("version", 1)))
                            onStatus(if (source.optBoolean("paused")) "Resumed." else "Paused.")
                            reload += 1
                            onChanged()
                        }
                    }
                }) { Text(if (source.optBoolean("paused")) "Resume" else "Pause") }
                TextButton(onClick = {
                    scope.launch {
                        runIo(onError) {
                            api.request("POST", "/api/households/$hid/income-sources/${source.optString("id")}/archive", JSONObject().put("version", source.optInt("version", 1)))
                            onStatus("Archived.")
                            if (editing?.optString("id") == source.optString("id")) editing = null
                            reload += 1
                            onChanged()
                        }
                    }
                }) { Text("Archive") }
            }
        }
        val archivedSources = data.optJSONArray("archivedSources") ?: JSONArray()
        if (archivedSources.length() > 0) Text("Archived")
        for (index in 0 until archivedSources.length()) {
            val source = archivedSources.getJSONObject(index)
            Text(source.optString("name"))
            TextButton(onClick = {
                scope.launch {
                    runIo(onError) {
                        api.request("POST", "/api/households/$hid/income-sources/${source.optString("id")}/restore", JSONObject().put("version", source.optInt("version", 1)))
                        onStatus("Restored.")
                        reload += 1
                        onChanged()
                    }
                }
            }) { Text("Restore") }
        }
        val receipts = data.optJSONArray("expectedReceipts") ?: JSONArray()
        if (receipts.length() == 0) Text("Nothing in this window is still expected.")
        for (index in 0 until receipts.length()) {
            val item = receipts.getJSONObject(index)
            var version = 1
            for (sourceIndex in 0 until sources.length()) if (sources.getJSONObject(sourceIndex).optString("id") == item.optString("sourceId")) version = sources.getJSONObject(sourceIndex).optInt("version", 1)
            ReceiptActions(api, hid, item, version, privacy, onError, onStatus) { reload += 1; onChanged() }
        }
        Text(data.optString("explanation"))
    }
    if (openId.isNotBlank()) {
        TextButton(onClick = { openId = "" }) { Text("Close paycheck") }
        RemoteScreen("income-$openId-$reload", { api.request("GET", "/api/households/$hid/income-sources/$openId") }) { detail ->
            Text(detail.optString("explanation"))
            val history = detail.optJSONArray("history") ?: JSONArray()
            if (history.length() == 0) Text("No receipts or revisions yet.")
            for (index in 0 until history.length()) {
                val row = history.getJSONObject(index)
                val shown = if (row.has("receivedAmountMinor") && !row.isNull("receivedAmountMinor")) row.optLong("receivedAmountMinor") else row.optLong("expectedAmountMinor")
                Text("${row.optString("expectedDate")} · ${row.optString("status")} · ${money(shown, privacy)}")
            }
            val candidates = detail.optJSONArray("linkCandidates") ?: JSONArray()
            var linkDate by remember(openId) { mutableStateOf("") }
            OutlinedTextField(linkDate, { linkDate = it }, label = { Text("Expected date to link") }, modifier = Modifier.fillMaxWidth())
            if (candidates.length() == 0) Text("No unlinked income deposit is available.")
            for (index in 0 until candidates.length()) {
                val txn = candidates.getJSONObject(index)
                TextButton(onClick = {
                    scope.launch {
                        runIo(onError) {
                            if (linkDate.isBlank()) { onError("Enter the expected date to link."); return@runIo }
                            val saved = api.request("POST", "/api/households/$hid/income-sources/$openId/receive", JSONObject()
                                .put("expectedDate", linkDate)
                                .put("opId", java.util.UUID.randomUUID().toString())
                                .put("mode", "link")
                                .put("transactionId", txn.optString("id")))
                            onStatus(saved.optString("note").ifBlank { "Linked." })
                            reload += 1
                            onChanged()
                        }
                    }
                }) { Text("Link ${txn.optString("date")} ${txn.optString("payee")} ${money(txn.optLong("amountMinor"), privacy)}") }
            }
        }
    }
    IncomeSourceForm(dash, editing, onError, onClose = { editing = null }) { body ->
        scope.launch {
            runIo(onError) {
                val current = editing
                val saved = if (current == null) {
                    body.put("spaceId", dash?.optString("spaceId"))
                    api.request("POST", "/api/households/$hid/income-sources", body)
                } else {
                    body.put("spaceId", current.optString("spaceId").ifBlank { dash?.optString("spaceId") ?: "" })
                    body.put("version", current.optInt("version", 1))
                    api.request("PATCH", "/api/households/$hid/income-sources/${current.optString("id")}", body)
                }
                onStatus(saved.optString("note").ifBlank { "Saved." })
                editing = null
                reload += 1
                onChanged()
            }
        }
    }
}

@Composable
private fun ReceiptActions(api: BudgetApi, hid: String, item: JSONObject, version: Int, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val expectedDate = item.optString("expectedDate").ifBlank { item.optString("date") }
    var amount by remember(expectedDate) { mutableStateOf(amountField(item.optLong("amountMinor"))) }
    var delayedUntil by remember(expectedDate) { mutableStateOf("") }
    var revisedDate by remember(expectedDate) { mutableStateOf("") }
    var revisedAmount by remember(expectedDate) { mutableStateOf("") }
    Text("${item.optString("date")} ${item.optString("name")} ${item.optString("status")} ${money(item.optLong("amountMinor"), privacy)}")
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount received") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Row {
        TextButton(onClick = { scope.launch { runIo(onError) { receivePaycheck(api, hid, item.optString("sourceId"), expectedDate, "full", parseDollars(amount)); onStatus("Recorded."); onDone() } } }) { Text("Record received") }
        TextButton(onClick = { scope.launch { runIo(onError) { receivePaycheck(api, hid, item.optString("sourceId"), expectedDate, "partial", parseDollars(amount)); onStatus("Partial receipt recorded."); onDone() } } }) { Text("Record partial") }
    }
    OutlinedTextField(delayedUntil, { delayedUntil = it }, label = { Text("Delayed until") }, modifier = Modifier.fillMaxWidth())
    TextButton(onClick = {
        scope.launch {
            runIo(onError) {
                api.request("POST", "/api/households/$hid/income-sources/${item.optString("sourceId")}/delay", JSONObject().put("expectedDate", expectedDate).put("delayedUntil", delayedUntil))
                onStatus("Delayed. No income was posted.")
                onDone()
            }
        }
    }) { Text("Mark delayed") }
    TextButton(onClick = {
        scope.launch {
            runIo(onError) {
                api.request("POST", "/api/households/$hid/income-sources/${item.optString("sourceId")}/cancel", JSONObject().put("expectedDate", expectedDate))
                onStatus("Cancelled. No income was posted.")
                onDone()
            }
        }
    }) { Text("Cancel this date") }
    OutlinedTextField(revisedDate, { revisedDate = it }, label = { Text("New date") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(revisedAmount, { revisedAmount = it }, label = { Text("New amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Row {
        TextButton(onClick = { scope.launch { runIo(onError) { revisePaycheck(api, hid, item.optString("sourceId"), expectedDate, "one", revisedDate, revisedAmount, version); onStatus("That date was changed."); onDone() } } }) { Text("Change this date") }
        TextButton(onClick = { scope.launch { runIo(onError) { revisePaycheck(api, hid, item.optString("sourceId"), expectedDate, "future", revisedDate, revisedAmount, version); onStatus("Future dates were changed."); onDone() } } }) { Text("Change future dates") }
    }
}

private suspend fun receivePaycheck(api: BudgetApi, hid: String, sourceId: String, expectedDate: String, mode: String, amountMinor: Long) {
    api.request("POST", "/api/households/$hid/income-sources/$sourceId/receive", JSONObject()
        .put("expectedDate", expectedDate)
        .put("opId", java.util.UUID.randomUUID().toString())
        .put("mode", mode)
        .put("amountMinor", amountMinor)
        .put("receivedDate", LocalDate.now().toString()))
}

private suspend fun revisePaycheck(api: BudgetApi, hid: String, sourceId: String, expectedDate: String, scope: String, revisedDate: String, revisedAmount: String, version: Int) {
    val body = JSONObject().put("expectedDate", expectedDate).put("scope", scope).put("version", version)
    if (revisedDate.isNotBlank()) body.put("date", revisedDate)
    if (revisedAmount.isNotBlank()) body.put("amountMinor", parseDollars(revisedAmount))
    api.request("POST", "/api/households/$hid/income-sources/$sourceId/revise", body)
}

@Composable
private fun IncomeSourceForm(dash: JSONObject?, initial: JSONObject?, onError: (String) -> Unit, onClose: () -> Unit, onSave: (JSONObject) -> Unit) {
    val formKey = initial?.let { "${it.optString("id")}:${it.optInt("version", 1)}" } ?: "new"
    val dates = initial?.optJSONArray("dates")
    val twice = initial?.optJSONArray("twiceDays")
    var name by remember(formKey) { mutableStateOf(initial?.optString("name") ?: "") }
    var kind by remember(formKey) { mutableStateOf(initial?.optString("kind")?.ifBlank { "salary" } ?: "salary") }
    var cadence by remember(formKey) { mutableStateOf(initial?.optString("cadence")?.ifBlank { "irregular" } ?: "irregular") }
    var amount by remember(formKey) { mutableStateOf(if (initial == null || initial.optLong("amountMinor") == 0L) "" else amountField(initial.optLong("amountMinor"))) }
    var high by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("amountMaxMinor")) "" else amountField(initial.optLong("amountMaxMinor"))) }
    var start by remember(formKey) { mutableStateOf(initial?.optString("startDate")?.ifBlank { LocalDate.now().toString() } ?: LocalDate.now().toString()) }
    var end by remember(formKey) { mutableStateOf(initial?.optString("endDate") ?: "") }
    var interval by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("customInterval")) "" else initial.optInt("customInterval").toString()) }
    var anchor by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("anchorDay")) "" else initial.optInt("anchorDay").toString()) }
    var dayA by remember(formKey) { mutableStateOf(twice?.optInt(0)?.takeIf { it > 0 }?.toString() ?: "1") }
    var dayB by remember(formKey) { mutableStateOf(twice?.optInt(1)?.takeIf { it > 0 }?.toString() ?: "15") }
    val datedAmounts = remember(formKey) {
        val seed = mutableStateListOf<Pair<String, String>>()
        val count = maxOf(dates?.length() ?: 0, 2)
        for (index in 0 until count) {
            val row = dates?.optJSONObject(index)
            seed.add((row?.optString("date") ?: "") to (row?.let { amountField(it.optLong("amountMinor")) } ?: ""))
        }
        seed
    }
    var accountId by remember(formKey) { mutableStateOf(initial?.optString("accountId") ?: "") }
    var notes by remember(formKey) { mutableStateOf(initial?.optString("notes") ?: "") }
    Text(if (initial == null) "New income source. Saving it does not change a balance." else "Edit ${initial.optString("name")}. Received paychecks stay in the register.")
    OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
    ChoiceRow("Kind", listOf("salary", "hourly", "freelance", "commission", "bonus", "seasonal", "benefit", "other", "irregular"), kind) { kind = it }
    ChoiceRow("Schedule", listOf("weekly", "biweekly", "twice_monthly", "monthly", "annual", "every_n_days", "every_n_weeks", "once", "irregular"), cadence) { cadence = it }
    if (cadence == "every_n_days" || cadence == "every_n_weeks") OutlinedTextField(interval, { interval = it }, label = { Text(if (cadence == "every_n_weeks") "Number of weeks" else "Number of days") }, modifier = Modifier.fillMaxWidth())
    if (cadence == "monthly" || cadence == "annual") OutlinedTextField(anchor, { anchor = it }, label = { Text("Anchored day") }, modifier = Modifier.fillMaxWidth())
    if (cadence == "twice_monthly") {
        OutlinedTextField(dayA, { dayA = it }, label = { Text("First day") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(dayB, { dayB = it }, label = { Text("Second day") }, modifier = Modifier.fillMaxWidth())
    }
    OutlinedTextField(amount, { amount = it }, label = { Text("Planning amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(high, { high = it }, label = { Text("High end, optional") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(start, { start = it }, label = { Text("Start date") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(end, { end = it }, label = { Text("End date") }, modifier = Modifier.fillMaxWidth())
    if (cadence == "irregular") {
        Text("Irregular dates. These do not repeat monthly.")
        datedAmounts.forEachIndexed { index, row ->
            OutlinedTextField(row.first, { value -> datedAmounts[index] = value to row.second }, label = { Text("Expected date ${index + 1}") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(row.second, { value -> datedAmounts[index] = row.first to value }, label = { Text("Amount ${index + 1}") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
        }
        TextButton(onClick = { datedAmounts.add("" to "") }) { Text("Add date") }
    }
    val accounts = dash?.optJSONArray("accounts") ?: JSONArray()
    Text("Deposit account")
    for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        if (account.optString("kind") !in setOf("checking", "savings", "cash")) continue
        TextButton(onClick = { accountId = account.optString("id") }) { Text(if (accountId == account.optString("id")) account.optString("name") else "Use ${account.optString("name")}") }
    }
    OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        try {
            if (name.isBlank() || accountId.isBlank()) { onError("Name the income and choose a checking, savings, or cash account."); return@Button }
            val body = JSONObject()
                .put("name", name.trim())
                .put("kind", kind)
                .put("cadence", cadence)
                .put("accountId", accountId)
                .put("amountMinor", if (amount.isBlank()) 0 else parseDollars(amount))
                .put("startDate", start)
                .put("notes", notes)
            if (high.isNotBlank()) body.put("amountMaxMinor", parseDollars(high))
            if (end.isNotBlank()) body.put("endDate", end)
            if (interval.isNotBlank()) body.put("customInterval", interval.toInt())
            if (anchor.isNotBlank()) body.put("anchorDay", anchor.toInt())
            if (cadence == "twice_monthly") body.put("twiceDays", org.json.JSONArray().put(dayA.toInt()).put(dayB.toInt()))
            if (cadence == "irregular") {
                val dates = org.json.JSONArray()
                datedAmounts.forEach { row ->
                    if (row.first.isNotBlank()) dates.put(JSONObject().put("date", row.first).put("amountMinor", parseDollars(row.second.ifBlank { "0" })))
                }
                body.put("dates", dates)
            }
            onSave(body)
        } catch (caught: Exception) {
            onError(caught.message ?: "Check the amounts and dates.")
        }
    }) { Text(if (initial == null) "Save income source" else "Save changes") }
    if (initial != null) TextButton(onClick = onClose) { Text("Close editor") }
}

@Composable
private fun CalendarScreen(api: BudgetApi, hid: String, privacy: Boolean, onError: (String) -> Unit) {
    var month by remember { mutableStateOf(LocalDate.now().withDayOfMonth(1)) }
    var focus by remember { mutableStateOf<JSONObject?>(null) }
    val from = month.toString()
    val to = month.withDayOfMonth(month.lengthOfMonth()).toString()
    Column {
        Row {
            TextButton(onClick = { month = month.minusMonths(1); focus = null }) { Text("Previous month") }
            Text(month.toString().substring(0, 7))
            TextButton(onClick = { month = month.plusMonths(1); focus = null }) { Text("Next month") }
        }
        RemoteScreen("calendar-$from", { api.request("GET", "/api/households/$hid/calendar?from=$from&to=$to") }) { data ->
            Text("Cash on hand ${money(data.optLong("actualCashMinor"), privacy)}")
            Text(data.optString("note"))
            val items = data.optJSONArray("items") ?: JSONArray()
            if (items.length() == 0) Text("Nothing is scheduled this month.")
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                TextButton(onClick = { focus = item }) { Text("${item.optString("date")} ${item.optString("name")} ${item.optString("status")} ${money(item.optLong("amountMinor"), privacy)}") }
            }
            val selected = focus
            if (selected != null) {
                Text("${selected.optString("name")} on ${selected.optString("date")}")
                Text("${selected.optString("kind")} · ${selected.optString("status")} · ${if (selected.optBoolean("estimate")) "estimate, not posted" else "confirmed"} · ${money(selected.optLong("amountMinor"), privacy)}")
                TextButton(onClick = { focus = null }) { Text("Back to ${month.toString().substring(0, 7)}") }
            }
        }
    }
}

@Composable
private fun BillsScreen(api: BudgetApi, hid: String, dash: JSONObject?, privacy: Boolean, onError: (String) -> Unit, onStatus: (String) -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    RemoteScreen("bills-$reload", { api.request("GET", "/api/households/$hid/schedules") }) { data ->
        val rows = data.optJSONArray("schedules") ?: JSONArray()
        if (rows.length() == 0) Text("No bills or income schedules yet.")
        for (index in 0 until rows.length()) {
            val row = rows.getJSONObject(index)
            val cadence = row.optString("scheduleMode").ifBlank { row.optString("cadence") }
            Text("${row.optString("nextDate")} ${row.optString("name")} · $cadence · ${money(row.optLong("amountMinor"), privacy)} ${row.optString("direction")}${if (row.optBoolean("paused")) " · Paused" else ""}")
            Row {
                TextButton(onClick = { editing = JSONObject(row.toString()) }) { Text("Edit") }
                if (row.optString("direction") == "outflow") {
                    TextButton(onClick = {
                        scope.launch { runIo(onError) { api.request("POST", "/api/households/$hid/schedules/${row.optString("id")}/skip", JSONObject()); onStatus("Skipped."); reload += 1; onChanged() } }
                    }) { Text("Skip this occurrence") }
                }
                if (row.optString("direction") == "outflow" && row.optString("bucketId").isNotBlank()) {
                    TextButton(onClick = {
                        scope.launch { runIo(onError) { val saved = api.request("POST", "/api/households/$hid/schedules/${row.optString("id")}/reserve", JSONObject()); onStatus(saved.optString("note").ifBlank { "Reserved." }); reload += 1; onChanged() } }
                    }) { Text("Reserve from cash") }
                }
            }
        }
    }
    BillForm(editing, onError, onClose = { editing = null }) { name, amount, direction, cadence, nextDate, interval, anchor, dayA, dayB, end ->
        scope.launch {
            runIo(onError) {
                val current = editing
                val body = JSONObject()
                    .put("spaceId", current?.optString("spaceId")?.ifBlank { null } ?: dash?.optString("spaceId"))
                    .put("name", name)
                    .put("cadence", cadence)
                    .put("nextDate", nextDate)
                    .put("amountMinor", amount)
                    .put("direction", direction)
                    .put("type", when {
                        direction == "inflow" -> "income"
                        current?.optString("type") == "subscription" -> "subscription"
                        else -> "bill"
                    })
                if (current?.optBoolean("paused") == true) body.put("paused", true)
                val accountId = current?.optString("accountId").orEmpty()
                val bucketId = current?.optString("bucketId").orEmpty()
                if (accountId.isNotBlank()) body.put("accountId", accountId)
                if (bucketId.isNotBlank()) body.put("bucketId", bucketId)
                if (interval != null) body.put("customInterval", interval)
                if (anchor != null) body.put("anchorDay", anchor)
                if (cadence == "twice_monthly") body.put("twiceDays", org.json.JSONArray().put(dayA).put(dayB))
                if (end.isNotBlank()) body.put("endDate", end)
                val saved = if (current == null) api.request("POST", "/api/households/$hid/schedules", body)
                else api.request("PATCH", "/api/households/$hid/schedules/${current.optString("id")}", body)
                onStatus(saved.optString("note").ifBlank { "Saved." })
                editing = null
                reload += 1
                onChanged()
            }
        }
    }
}

@Composable
private fun BillForm(initial: JSONObject?, onError: (String) -> Unit, onClose: () -> Unit, onSave: (String, Long, String, String, String, Int?, Int?, Int, Int, String) -> Unit) {
    val formKey = initial?.optString("id") ?: "new"
    val startingCadence = when {
        initial == null -> "monthly"
        initial.optString("scheduleMode").isNotBlank() -> initial.optString("scheduleMode")
        initial.optString("cadence").isNotBlank() && initial.optString("cadence") != "custom" -> initial.optString("cadence")
        else -> "monthly"
    }
    var name by remember(formKey) { mutableStateOf(initial?.optString("name") ?: "") }
    var amount by remember(formKey) { mutableStateOf(if (initial == null) "" else amountField(initial.optLong("amountMinor"))) }
    var direction by remember(formKey) { mutableStateOf(initial?.optString("direction")?.ifBlank { "outflow" } ?: "outflow") }
    var cadence by remember(formKey) { mutableStateOf(if (startingCadence.isBlank() || startingCadence == "custom") "monthly" else startingCadence) }
    var nextDate by remember(formKey) { mutableStateOf(initial?.optString("nextDate")?.ifBlank { LocalDate.now().plusDays(7).toString() } ?: LocalDate.now().plusDays(7).toString()) }
    var interval by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("interval")) "" else initial.optInt("interval").toString()) }
    var anchor by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("anchorDay")) "" else initial.optInt("anchorDay").toString()) }
    var dayA by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("twiceDayA")) "1" else initial.optInt("twiceDayA").toString()) }
    var dayB by remember(formKey) { mutableStateOf(if (initial == null || initial.isNull("twiceDayB")) "15" else initial.optInt("twiceDayB").toString()) }
    var end by remember(formKey) { mutableStateOf(initial?.optString("endDate") ?: "") }
    OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    ChoiceRow("Schedule", listOf("weekly", "biweekly", "twice_monthly", "monthly", "annual", "every_n_days", "every_n_weeks", "once"), cadence) { cadence = it }
    if (cadence == "every_n_days" || cadence == "every_n_weeks") OutlinedTextField(interval, { interval = it }, label = { Text(if (cadence == "every_n_weeks") "Number of weeks" else "Number of days") }, modifier = Modifier.fillMaxWidth())
    if (cadence == "monthly" || cadence == "annual") OutlinedTextField(anchor, { anchor = it }, label = { Text("Anchored day") }, modifier = Modifier.fillMaxWidth())
    if (cadence == "twice_monthly") {
        OutlinedTextField(dayA, { dayA = it }, label = { Text("First day") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(dayB, { dayB = it }, label = { Text("Second day") }, modifier = Modifier.fillMaxWidth())
    }
    OutlinedTextField(nextDate, { nextDate = it }, label = { Text("Next date") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(end, { end = it }, label = { Text("End date") }, modifier = Modifier.fillMaxWidth())
    Row {
        TextButton(onClick = { direction = "outflow" }) { Text(if (direction == "outflow") "Bill" else "Make it a bill") }
        TextButton(onClick = { direction = "inflow" }) { Text(if (direction == "inflow") "Income" else "Make it income") }
    }
    Text("A bill is an estimate until it is paid. Twice a month is not every two weeks. A missing custom interval is rejected and is not changed to 30 days.")
    Button(onClick = {
        if (name.isBlank() || amount.isBlank()) onError("Enter a name and amount.")
        else onSave(name, parseDollars(amount), direction, cadence, nextDate, interval.toIntOrNull(), anchor.toIntOrNull(), dayA.toIntOrNull() ?: 1, dayB.toIntOrNull() ?: 15, end)
    }) { Text(if (initial == null) "Add schedule" else "Save bill") }
    if (initial != null) TextButton(onClick = onClose) { Text("Close editor") }
}

@Composable
private fun BucketPick(dash: JSONObject?, kind: String, onSave: (String, String, Long) -> Unit) {
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    var bucketId by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var target by remember { mutableStateOf("") }
    Text("Envelope")
    for (index in 0 until buckets.length()) {
        val bucket = buckets.getJSONObject(index)
        if (bucket.optString("systemRole").isNotBlank() || bucket.optString("kind") != kind) continue
        TextButton(onClick = { bucketId = bucket.optString("id"); if (name.isBlank()) name = bucket.optString("name") }) {
            Text(if (bucket.optString("id") == bucketId) "Selected · ${bucket.optString("name")}" else bucket.optString("name"))
        }
    }
    OutlinedTextField(name, { name = it }, label = { Text("Goal name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(target, { target = it }, label = { Text("Target") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Button(onClick = { if (bucketId.isBlank() || target.isBlank()) return@Button else onSave(bucketId, name, parseDollars(target)) }) { Text("Save goal") }
}

@Composable
private fun RetirementScreen(onError: (String) -> Unit, onRun: (Int, Long, Long, Long) -> Unit) {
    var age by remember { mutableStateOf("35") }
    var portfolio by remember { mutableStateOf("") }
    var save by remember { mutableStateOf("") }
    var spend by remember { mutableStateOf("") }
    Text("This model does not change your accounts. The same inputs replay.")
    OutlinedTextField(age, { age = it }, label = { Text("Age") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(portfolio, { portfolio = it }, label = { Text("Portfolio") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(save, { save = it }, label = { Text("Annual contribution") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(spend, { spend = it }, label = { Text("Annual spending") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        if (portfolio.isBlank() || save.isBlank() || spend.isBlank()) onError("Enter the portfolio, contribution, and spending.")
        else onRun(age.toIntOrNull() ?: 35, parseDollars(portfolio), parseDollars(save), parseDollars(spend))
    }) { Text("Run model") }
}

@Composable
private fun RuleForm(onError: (String) -> Unit, onSave: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var payee by remember { mutableStateOf("") }
    OutlinedTextField(name, { name = it }, label = { Text("Rule name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(payee, { payee = it }, label = { Text("Payee contains") }, modifier = Modifier.fillMaxWidth())
    Button(onClick = { if (name.isBlank() || payee.isBlank()) onError("Name the rule and the payee.") else onSave(name, payee) }) { Text("Save rule") }
    Text("This rule marks a match for review. It does not change a category you already confirmed.")
}

@Composable
private fun AssistantScreen(onError: (String) -> Unit, onAsk: (String) -> Unit) {
    var question by remember { mutableStateOf("") }
    Text("Answers use figures from this household. They do not see accounts hidden from you.")
    OutlinedTextField(question, { question = it }, label = { Text("Question") }, modifier = Modifier.fillMaxWidth())
    Button(onClick = { if (question.isBlank()) onError("Ask about a figure you can see.") else onAsk(question) }) { Text("Ask") }
}

@Composable
private fun ImportScreen(dash: JSONObject?, onError: (String) -> Unit, onCommit: (String, String) -> Unit) {
    var text by remember { mutableStateOf("Date,Amount,Payee\n") }
    var accountId by remember { mutableStateOf("") }
    val accounts = dash?.optJSONArray("accounts") ?: JSONArray()
    Text("Choose the account these rows belong to. Nothing is imported until you commit.")
    for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        TextButton(onClick = { accountId = account.optString("id") }) {
            Text(if (account.optString("id") == accountId) "Selected · ${account.optString("name")}" else account.optString("name"))
        }
    }
    OutlinedTextField(text, { text = it }, label = { Text("CSV") }, modifier = Modifier.fillMaxWidth())
    Button(onClick = { if (accountId.isBlank()) onError("Choose an account.") else onCommit(text, accountId) }) { Text("Preview and import") }
}

@Composable
private fun SecurityScreen(api: BudgetApi, store: Store, onTheme: (String) -> Unit, onError: (String) -> Unit, onDeleted: () -> Unit) {
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    Text("Theme follows this device and your account.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("system", "light", "dark").forEach { choice ->
            TextButton(onClick = {
                onTheme(choice)
                scope.launch { runIo(onError) { api.request("PATCH", "/api/me", JSONObject().put("theme", choice)) } }
            }) { Text(choice.replaceFirstChar { it.titlecase() }) }
        }
    }
    RemoteScreen("sessions", { api.request("GET", "/api/auth/sessions") }) { data ->
        val sessions = data.optJSONArray("sessions") ?: JSONArray()
        for (index in 0 until sessions.length()) {
            val session = sessions.getJSONObject(index)
            Text(session.optString("device_label").ifBlank { "Session" })
            if (session.isNull("revoked_at")) {
                TextButton(onClick = {
                    scope.launch { runIo(onError) { api.request("DELETE", "/api/auth/sessions/${session.optString("id")}"); onError("That session was signed out.") } }
                }) { Text("Sign that device out") }
            }
        }
    }
    OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        scope.launch {
            runIo(onError) {
                api.request("DELETE", "/api/me", JSONObject().put("password", password).put("confirm", "DELETE"))
                onDeleted()
            }
        }
    }) { Text("Delete account") }
    Text("Deletion removes the user and a household you alone own. It asks for the password and the confirmation word.")
}

@Composable
private fun ReportScreen(api: BudgetApi, hid: String, privacy: Boolean, onError: (String) -> Unit, onOpen: (String, String) -> Unit) {
    var flow by remember { mutableStateOf<JSONObject?>(null) }
    var spending by remember { mutableStateOf<JSONObject?>(null) }
    var loadError by remember { mutableStateOf("") }
    LaunchedEffect(hid) {
        try {
            val loaded = withContext(Dispatchers.IO) {
                api.request("GET", "/api/households/$hid/reports/sankey") to api.request("GET", "/api/households/$hid/reports/spending?by=bucket")
            }
            flow = loaded.first
            spending = loaded.second
            loadError = ""
        } catch (caught: Exception) {
            loadError = caught.message ?: "Could not load reports."
        }
    }
    if (flow == null && loadError.isBlank()) Text("Loading…")
    if (loadError.isNotBlank() && flow == null) Text(loadError)
    flow?.let { data ->
        Text("${data.optString("from")} to ${data.optString("to")} · ${data.optString("currency")}")
        Text(data.optString("formula"))
        val links = data.optJSONArray("links") ?: JSONArray()
        if (links.length() == 0) Text("No cash flow in this period.")
        for (index in 0 until links.length()) {
            val link = links.getJSONObject(index)
            Text("${link.optString("source")} → ${link.optString("target")} ${money(link.optLong("amountMinor"), privacy)}")
        }
    }
    spending?.let { data ->
        Text("Spending", style = MaterialTheme.typography.titleMedium)
        Text("${data.optString("from")} to ${data.optString("to")}. ${data.optString("formula")} Total ${money(data.optLong("totalMinor"), privacy)}.")
        val rows = data.optJSONArray("rows") ?: JSONArray()
        if (rows.length() == 0) Text("No spending in this period.")
        for (index in 0 until rows.length()) {
            val row = rows.getJSONObject(index)
            val ids = row.optJSONArray("transactionIds") ?: JSONArray()
            val label = row.optString("label").ifBlank { "Uncategorized" }
            if (ids.length() == 0) {
                Text("$label ${money(row.optLong("amountMinor"), privacy)}")
            } else {
                TextButton(onClick = {
                    if (ids.length() > 200) {
                        onError("That row has more transactions than this screen can open at once.")
                        return@TextButton
                    }
                    val joined = (0 until ids.length()).joinToString(",") { ids.optString(it) }
                    onOpen(joined, label)
                }, modifier = Modifier.fillMaxWidth()) {
                    Text("Open $label ${money(row.optLong("amountMinor"), privacy)}")
                }
            }
        }
    }
}

@Composable
private fun RemoteScreen(key: String, load: suspend () -> JSONObject, content: @Composable (JSONObject) -> Unit) {
    var data by remember(key) { mutableStateOf<JSONObject?>(null) }
    var error by remember(key) { mutableStateOf("") }
    LaunchedEffect(key) {
        try {
            data = withContext(Dispatchers.IO) { load() }
            error = ""
        } catch (caught: Exception) {
            error = caught.message ?: "Could not load."
        }
    }
    if (data == null && error.isBlank()) Text("Loading…")
    if (error.isNotBlank() && data == null) Text(error)
    data?.let { content(it) }
}

private suspend fun runIo(onError: (String) -> Unit, block: suspend () -> Unit) {
    try {
        withContext(Dispatchers.IO) { block() }
    } catch (caught: Exception) {
        withContext(Dispatchers.Main.immediate) { onError(caught.message ?: "That did not work.") }
    }
}
