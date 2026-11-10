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
        "bills" -> RemoteScreen("bills", { api.request("GET", "/api/households/$hid/schedules") }) { data ->
            val rows = data.optJSONArray("schedules") ?: JSONArray()
            if (rows.length() == 0) Text("No bills or income schedules yet.")
            for (index in 0 until rows.length()) {
                val row = rows.getJSONObject(index)
                Text("${row.optString("nextDate")} ${row.optString("name")} ${money(row.optLong("amountMinor"), privacy)} ${row.optString("direction")}")
                if (row.optString("direction") == "outflow") {
                    TextButton(onClick = {
                        scope.launch { runIo(onError) { api.request("POST", "/api/households/$hid/schedules/${row.optString("id")}/skip", JSONObject()); onChanged() } }
                    }) { Text("Skip this occurrence") }
                }
            }
            BillForm(onError) { name, amount, direction ->
                scope.launch {
                    runIo(onError) {
                        api.request("POST", "/api/households/$hid/schedules", JSONObject()
                            .put("spaceId", dash?.optString("spaceId"))
                            .put("name", name)
                            .put("cadence", "monthly")
                            .put("nextDate", LocalDate.now().plusDays(7).toString())
                            .put("amountMinor", amount)
                            .put("direction", direction)
                            .put("type", if (direction == "inflow") "income" else "bill"))
                        onChanged()
                    }
                }
            }
        }
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
        "debts" -> DebtScreen(api, hid, privacy)
        "categories" -> CategoryScreen(api, hid, dash, onError, onStatus, onChanged)
        "fills" -> FillsScreen(api, hid, dash, onError, onStatus, onChanged)
        "paycheck" -> RemoteScreen("paycheck", { api.request("GET", "/api/households/$hid/income-plan?spaceId=${dash?.optString("spaceId") ?: ""}") }) { data ->
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
        "reports" -> RemoteScreen("reports", { api.request("GET", "/api/households/$hid/reports/sankey") }) { data ->
            Text("${data.optString("from")} to ${data.optString("to")} · ${data.optString("currency")}")
            Text(data.optString("formula"))
            val links = data.optJSONArray("links") ?: JSONArray()
            if (links.length() == 0) Text("No cash flow in this period.")
            for (index in 0 until links.length()) {
                val link = links.getJSONObject(index)
                Text("${link.optString("source")} → ${link.optString("target")} ${money(link.optLong("amountMinor"), privacy)}")
            }
            TextButton(onClick = {
                scope.launch {
                    runIo(onError) {
                        val spending = api.request("GET", "/api/households/$hid/reports/spending?by=bucket")
                        onStatus("${spending.optString("from")} to ${spending.optString("to")} · ${spending.optString("currency")}. ${spending.optString("formula")} Total ${money(spending.optLong("totalMinor"), privacy)}.")
                    }
                }
            }) { Text("Spending total") }
        }
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
private fun DebtScreen(api: BudgetApi, hid: String, privacy: Boolean) {
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
            Text("${debt.optString("name")} ${money(debt.optLong("balanceMinor"), privacy)} · APR ${debt.optInt("aprBps") / 100.0}%")
        }
        val plan = data.optJSONObject("plan")
        if (plan != null && !plan.isNull("debtFreeDate")) Text("Debt-free date ${plan.optString("debtFreeDate")} · interest ${money(plan.optLong("totalInterestMinor"), privacy)}")
        else if (plan != null) Text("The model did not reach zero with these payments.")
    }
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
private fun CategoryScreen(api: BudgetApi, hid: String, dash: JSONObject?, onError: (String) -> Unit, onStatus: (String) -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    val period = dash?.optJSONObject("budget")?.optString("periodKey") ?: java.time.LocalDate.now().toString().take(7)
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    BackHandler(enabled = editing != null) { editing = null }
    val funding = dash?.optJSONObject("funding")
    if (funding != null) Text("Eligible posted income ${money(funding.optLong("eligiblePostedIncomeMinor"), false)}. ${funding.optString("formula")}")
    if (editing == null) {
        if (buckets.length() == 0) Text("No categories yet.")
        for (index in 0 until buckets.length()) {
            val bucket = buckets.getJSONObject(index)
            if (bucket.optString("systemRole").isNotBlank() || bucket.optBoolean("archived")) continue
            val style = bucket.optString("envelopeStyle").ifBlank { "regular" }
            Text("${bucket.optString("name")} · ${bucket.optString("kind")} · ${bucket.optString("flexRole").ifBlank { "flexible" }} · $style")
            TextButton(onClick = { editing = bucket }) { Text("Edit ${bucket.optString("name")}") }
        }
        CategoryForm(null, period, onError) { body ->
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
                    Text("Eligible ${money(funding.optLong("eligiblePostedIncomeMinor"), false)} · ${row.optString("percentLabel")} · target ${money(row.optLong("targetMinor"), false)} · funded ${money(row.optLong("fundedMinor"), false)} · still needed ${money(row.optLong("shortfallMinor"), false)}")
                }
            }
        }
        CategoryForm(current, period, onError) { body ->
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
private fun CategoryForm(existing: JSONObject?, period: String, onError: (String) -> Unit, onSave: (JSONObject) -> Unit) {
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
    var targetAmount by remember(existing?.optString("id")) { mutableStateOf(if (target == null) "" else money(target.optLong("amountMinor"), false).removePrefix("$")) }
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
    Text("A rollover change applies when that month closes. Earlier months stay put unless you recalculate from the web app and review the change.")
    ChoiceRow("Target", listOf("none", "refill", "set_aside", "balance_by_date", "maintain_balance", "debt_payment"), targetType) { targetType = it }
    OutlinedTextField(targetAmount, { targetAmount = it }, label = { Text("Target amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(percent, { percent = it }, label = { Text("Percent of eligible posted income") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(due, { due = it }, label = { Text("Target date") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(paused, { paused = it }, label = { Text("Pause until YYYY-MM-DD") }, modifier = Modifier.fillMaxWidth())
    if (existing != null) TextButton(onClick = { archived = !archived }) { Text(if (archived) "Archived — tap to restore" else "Archive this category") }
    Button(onClick = {
        try {
            if (name.isBlank()) { onError("Name the category."); return@Button }
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
            onSave(body)
        } catch (caught: Exception) {
            onError(caught.message ?: "Check the amounts and percent.")
        }
    }) { Text(if (existing == null) "Add category" else "Save category") }
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
private fun FillsScreen(api: BudgetApi, hid: String, dash: JSONObject?, onError: (String) -> Unit, onStatus: (String) -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableStateOf(0) }
    Text("A fill assigns cash already in the budget. It is not a bank transfer. Saved and Scheduled are not the same as Applied.")
    RemoteScreen("fills-$reload", { api.request("GET", "/api/households/$hid/fills") }) { data ->
        Text(data.optString("note"))
        val fills = data.optJSONArray("fills") ?: JSONArray()
        if (fills.length() == 0) Text("No saved fills yet.")
        for (index in 0 until fills.length()) {
            val fill = fills.getJSONObject(index)
            Text("${fill.optString("name")} · ${fill.optString("statusLabel")} · next ${fill.optString("nextDate").ifBlank { "none" }}")
            val last = fill.optJSONObject("lastOutcome")
            if (last == null) Text("No occurrence has run.") else Text("Last result ${last.optString("statusLabel")} ${money(last.optLong("allocatedMinor"), false)}")
            Row {
                TextButton(onClick = { fillAction(scope, api, hid, fill.optString("id"), "run", onError, onStatus) { reload += 1; onChanged() } }) { Text("Run now") }
                TextButton(onClick = { fillAction(scope, api, hid, fill.optString("id"), "skip", onError, onStatus) { reload += 1; onChanged() } }) { Text("Skip") }
                TextButton(onClick = {
                    val action = if (fill.optString("statusLabel") == "Paused") "resume" else "pause"
                    fillAction(scope, api, hid, fill.optString("id"), action, onError, onStatus) { reload += 1; onChanged() }
                }) { Text(if (fill.optString("statusLabel") == "Paused") "Resume" else "Pause") }
            }
        }
    }
    FillForm(dash, onError) { body ->
        scope.launch {
            try {
                withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/fills", body) }
                onStatus("Fill saved. It has not moved any money.")
                reload += 1
                onChanged()
            } catch (caught: Exception) {
                onError(caught.message ?: "Could not save the fill.")
            }
        }
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

@Composable
private fun FillForm(dash: JSONObject?, onError: (String) -> Unit, onSave: (JSONObject) -> Unit) {
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    val choices = (0 until buckets.length()).map { buckets.getJSONObject(it) }.filter { it.optString("systemRole").isBlank() && !it.optBoolean("archived") }
    var name by remember { mutableStateOf("Payday fill") }
    var cadence by remember { mutableStateOf("monthly") }
    var policy by remember { mutableStateOf("partial") }
    var bucketId by remember { mutableStateOf(choices.firstOrNull()?.optString("id") ?: "") }
    var mode by remember { mutableStateOf("add") }
    var amount by remember { mutableStateOf("") }
    var secondId by remember { mutableStateOf("") }
    var secondAmount by remember { mutableStateOf("") }
    OutlinedTextField(name, { name = it }, label = { Text("Fill name") }, modifier = Modifier.fillMaxWidth())
    ChoiceRow("Schedule", listOf("once", "weekly", "biweekly", "twice_monthly", "monthly", "annual"), cadence) { cadence = it }
    ChoiceRow("If cash is short", listOf("partial", "skip"), policy) { policy = it }
    Text(if (policy == "skip") "The whole occurrence is skipped when cash is short." else "Envelopes are funded in priority order until Ready to Assign runs out.")
    Text("Envelope")
    Row { choices.forEach { choice -> TextButton(onClick = { bucketId = choice.optString("id") }) { Text(if (bucketId == choice.optString("id")) "Selected ${choice.optString("name")}" else choice.optString("name")) } } }
    ChoiceRow("Action", listOf("add", "top_up", "shortfall", "percent"), mode) { mode = it }
    OutlinedTextField(amount, { amount = it }, label = { Text(if (mode == "percent") "Percent" else "Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Text("Second envelope, optional")
    Row {
        TextButton(onClick = { secondId = "" }) { Text(if (secondId.isBlank()) "No second envelope" else "Clear second") }
        choices.forEach { choice -> TextButton(onClick = { secondId = choice.optString("id") }) { Text(choice.optString("name")) } }
    }
    OutlinedTextField(secondAmount, { secondAmount = it }, label = { Text("Second amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        try {
            if (bucketId.isBlank()) { onError("Choose an envelope."); return@Button }
            val first = JSONObject().put("bucketId", bucketId).put("mode", mode).put("priority", 1)
            if (mode == "percent") first.put("percentBps", percentBps(amount)) else if (mode != "shortfall") first.put("amountMinor", parseDollars(amount.ifBlank { "0" }))
            val lines = org.json.JSONArray().put(first)
            if (secondId.isNotBlank()) lines.put(JSONObject().put("bucketId", secondId).put("mode", "add").put("priority", 2).put("amountMinor", parseDollars(secondAmount.ifBlank { "0" })))
            onSave(JSONObject()
                .put("spaceId", dash?.optString("spaceId"))
                .put("name", name)
                .put("cadence", cadence)
                .put("startDate", java.time.LocalDate.now().toString())
                .put("shortfallPolicy", policy)
                .put("lines", lines))
        } catch (caught: Exception) {
            onError(caught.message ?: "Check the amounts.")
        }
    }) { Text("Save fill") }
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
private fun BillForm(onError: (String) -> Unit, onSave: (String, Long, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var direction by remember { mutableStateOf("outflow") }
    OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Row {
        TextButton(onClick = { direction = "outflow" }) { Text(if (direction == "outflow") "Bill" else "Make it a bill") }
        TextButton(onClick = { direction = "inflow" }) { Text(if (direction == "inflow") "Income" else "Make it income") }
    }
    Button(onClick = {
        if (name.isBlank() || amount.isBlank()) onError("Enter a name and amount.") else onSave(name, parseDollars(amount), direction)
    }) { Text("Add schedule") }
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
