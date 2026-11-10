package com.budgetcents.app.ui

import android.app.NotificationManager
import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationCompat
import com.budgetcents.app.ApiException
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.MainActivity
import com.budgetcents.app.R
import com.budgetcents.app.Store
import com.budgetcents.app.widget.refreshWidgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

private val Teal = Color(0xFF0C6B63)
private val Ink = Color(0xFF152033)
private val Tabs = listOf("Home", "Plan", "Activity", "Wealth", "More")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BudgetApp(activity: MainActivity, start: String) {
    val context = LocalContext.current
    val store = remember { Store(context.applicationContext) }
    val api = remember { BudgetApi(store) }
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf(store.token) }
    var locked by remember { mutableStateOf(store.biometric && store.token != null) }
    var tab by remember { mutableIntStateOf(tabIndex(start)) }
    var page by remember { mutableStateOf(subpage(start)) }
    var error by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var dash by remember { mutableStateOf<JSONObject?>(null) }
    var txns by remember { mutableStateOf<JSONObject?>(null) }
    var themeName by remember { mutableStateOf(store.theme) }
    val dark = when (themeName) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val wide = LocalConfiguration.current.screenWidthDp >= 840

    fun reload() {
        val hid = store.householdId ?: return
        scope.launch {
            error = ""
            status = ""
            try {
                flushQueue(api, store)
                val loaded = withContext(Dispatchers.IO) { api.dashboard(hid) }
                val activityRows = withContext(Dispatchers.IO) { api.transactions(hid) }
                dash = loaded
                txns = activityRows
                val guidance = loaded.getJSONObject("guidance")
                val short = guidance.optString("primaryFigure") == "shortage"
                val amount = if (short) guidance.optLong("shortageMinor") else guidance.optLong("cashSafeMinor")
                val label = if (short) "Short" else "Safe to spend"
                store.summary = "$label ${money(amount, store.privacy)}"
                refreshWidgets(context)
                notifyAlerts(context, loaded)
            } catch (caught: Exception) {
                error = caught.message ?: "Could not reach BudgetCents."
            }
        }
    }

    MaterialTheme(colorScheme = if (dark) {
        darkColorScheme(primary = Color(0xFF8FD0C8), onPrimary = Color(0xFF00332F), background = Color(0xFF101614), surface = Color(0xFF1A2422))
    } else {
        lightColorScheme(primary = Teal, onPrimary = Color.White, background = Color(0xFFF3F6F4), surface = Color.White)
    }) {
        if (token == null) {
            SignIn(store, api, error) { message ->
                if (message != null) error = message else {
                    token = store.token
                    themeName = store.theme
                    error = ""
                    reload()
                }
            }
            return@MaterialTheme
        }
        if (locked) {
            Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("BudgetCents", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
                Text("Unlock this device to see the household.")
                Button(onClick = { activity.unlock({ locked = false; reload() }, { error = it }) }) { Text("Unlock") }
                if (error.isNotBlank()) Text(error)
            }
            return@MaterialTheme
        }
        BackHandler(enabled = page != null) { page = null }
        LaunchedEffect(token) { reload() }
        Scaffold(bottomBar = {
            if (!wide) {
                NavigationBar {
                    Tabs.forEachIndexed { index, label ->
                        NavigationBarItem(selected = tab == index && page == null, onClick = { tab = index; page = null }, icon = {}, label = { Text(label) })
                    }
                }
            }
        }) { padding ->
            Row(Modifier.padding(padding).fillMaxSize()) {
                if (wide) {
                    NavigationRail {
                        Tabs.forEachIndexed { index, label ->
                            NavigationRailItem(selected = tab == index && page == null, onClick = { tab = index; page = null }, icon = {}, label = { Text(label) })
                        }
                    }
                }
                Column(Modifier.weight(1f).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (error.isNotBlank()) Text(error, color = Color(0xFFB85C50))
                    if (status.isNotBlank()) Text(status)
                    val pending = store.pendingForCurrentUser()
                    if (pending.isNotEmpty()) {
                        Text("${pending.size} saved on this phone. They send when BudgetCents can be reached, and only for this sign-in.")
                        pending.take(3).forEach { item ->
                            val body = runCatching { JSONObject(item.optString("body")) }.getOrNull()
                            Text("${body?.optString("payee") ?: "Transaction"} is still waiting.")
                        }
                        TextButton(onClick = { reload() }) { Text("Try again") }
                    }
                    if (page != null) {
                        FeatureScreen(page!!, api, store, dash, store.privacy, { page = null }, { reload() }, { error = it }, { error = ""; status = it }, {
                            store.clearSession(); token = null; dash = null; txns = null; page = null
                        }) { name ->
                            themeName = name
                            store.theme = name
                        }
                    } else when (tab) {
                        0 -> HomeTab(dash, store.privacy)
                        1 -> PlanTab(dash, store.privacy) { bucketId, amount ->
                            scope.launch {
                                runCatching {
                                    withContext(Dispatchers.IO) {
                                        api.assign(store.householdId!!, JSONObject().put("spaceId", dash?.optString("spaceId")).put("bucketId", bucketId).put("periodKey", dash?.getJSONObject("budget")?.optString("periodKey")).put("amountMinor", amount))
                                    }
                                }.onSuccess { reload() }.onFailure { error = it.message ?: "Could not assign." }
                            }
                        }
                        2 -> ActivityTab(txns, dash, store.privacy, activity, { message -> error = message }, { body, receipt ->
                            scope.launch {
                                try {
                                    if (!body.has("opId")) body.put("opId", UUID.randomUUID().toString())
                                    val created = withContext(Dispatchers.IO) { api.createTransaction(store.householdId!!, body) }
                                    if (receipt != null && created.has("id")) {
                                        withContext(Dispatchers.IO) { api.uploadReceipt(store.householdId!!, created.getString("id"), receipt) }
                                        error = "Receipt saved. OCR is not connected, so the amount you typed was not changed."
                                    }
                                    status = "Saved."
                                    reload()
                                } catch (caught: Exception) {
                                    if (caught is java.io.IOException) {
                                        store.enqueue("/api/households/${store.householdId}/transactions", body.toString())
                                        error = "Offline. The transaction stays on this phone until the server is reachable."
                                        reload()
                                    } else error = caught.message ?: "Could not save."
                                }
                            }
                        }) { id, patch ->
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { api.request("PATCH", "/api/households/${store.householdId}/transactions/$id", patch) }
                                    status = "Transaction updated."
                                    reload()
                                } catch (caught: Exception) {
                                    error = caught.message ?: "Could not update that transaction."
                                }
                            }
                        }
                        3 -> WealthTab(dash, store.privacy) { page = it }
                        else -> MoreTab(store, { name ->
                            themeName = name
                            store.theme = name
                            scope.launch {
                                runCatching { withContext(Dispatchers.IO) { api.request("PATCH", "/api/me", JSONObject().put("theme", name)) } }
                                    .onFailure { error = it.message ?: "Theme saved on this phone. The account was not updated." }
                            }
                        }, { page = it }, { reload() }) {
                            store.clearSession(); token = null; dash = null; txns = null; page = null
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SignIn(store: Store, api: BudgetApi, error: String, done: (String?) -> Unit) {
    var base by remember { mutableStateOf(store.baseUrl) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("BudgetCents", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
        Text("Same household as the web app. The emulator reaches a computer at 10.0.2.2.", color = Ink)
        OutlinedTextField(base, { base = it }, label = { Text("Server") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        if (error.isNotBlank()) Text(error)
        Button(onClick = {
            store.baseUrl = base
            scope.launch { sign(api, store, done) { api.login(email.trim(), password) } }
        }, modifier = Modifier.fillMaxWidth()) { Text("Sign in") }
        TextButton(onClick = {
            store.baseUrl = base
            scope.launch { sign(api, store, done) { api.demo() } }
        }) { Text("Open the sample household") }
    }
}

private suspend fun sign(api: BudgetApi, store: Store, done: (String?) -> Unit, call: () -> JSONObject) {
    try {
        val result = withContext(Dispatchers.IO) { call() }
        store.token = result.getString("token")
        val user = result.optJSONObject("user")
        if (user != null) {
            store.userId = user.getString("id")
            store.theme = user.optString("theme", store.theme)
        }
        val homes = withContext(Dispatchers.IO) { api.households() }
        store.householdId = homes.getJSONArray("households").getJSONObject(0).getString("id")
        done(null)
    } catch (caught: Exception) {
        done(caught.message ?: "Could not sign in.")
    }
}

@Composable
private fun HomeTab(dash: JSONObject?, privacy: Boolean) {
    if (dash == null) { Text("Loading the household…"); return }
    val guidance = dash.getJSONObject("guidance")
    val budget = dash.getJSONObject("budget")
    val worth = dash.getJSONObject("netWorth")
    val short = guidance.optString("primaryFigure") == "shortage"
    val committed = budget.optLong("claimsMinor") - budget.optLong("readyToAssignMinor") - budget.optLong("futureAssignedMinor")
    Text(if (short) "Short before upcoming bills" else "Safe to spend", color = MaterialTheme.colorScheme.primary)
    Text(money(if (short) guidance.optLong("shortageMinor") else guidance.optLong("cashSafeMinor"), privacy), style = MaterialTheme.typography.headlineLarge)
    Text(guidance.optString("formula"))
    Text("Ready to Assign ${money(budget.optLong("readyToAssignMinor"), privacy)}")
    Text("Already given a job ${money(committed, privacy)}")
    Text("Net worth ${money(worth.optLong("netMinor"), privacy)}")
    Text("Needs review ${dash.optInt("reviewCount")}")
    val upcoming = dash.optJSONArray("upcoming")
    if (upcoming == null || upcoming.length() == 0) Text("No bill is scheduled in the next month.")
    else {
        val next = (0 until upcoming.length()).map { upcoming.getJSONObject(it) }.firstOrNull { it.optLong("amountMinor") < 0 }
        if (next == null) Text("No outflow is scheduled in the next month.")
        else Text("Next bill ${next.optString("date")} ${next.optString("label")} ${money(next.optLong("amountMinor"), privacy)}")
    }
    val goals = dash.optJSONArray("goals")
    if (goals == null || goals.length() == 0) Text("No goal is using an envelope yet.")
    else Text("Goals ${goals.length()}. Open More, then Goals, to see progress.")
    if (budget.optLong("identityDifferenceMinor") != 0L) Text("The plan does not match cash. Review it before assigning more.")
    if (dash.optJSONObject("household")?.optBoolean("isDemo") == true) Text("Sample household. These figures are fictional.")
}

@Composable
private fun PlanTab(dash: JSONObject?, privacy: Boolean, onAssign: (String, Long) -> Unit) {
    if (dash == null) { Text("Loading the plan…"); return }
    val buckets = dash.getJSONArray("buckets")
    val rows = dash.getJSONObject("budget").getJSONArray("buckets")
    Text("Assign cash that has already arrived. Expected pay is not included.")
    if (rows.length() == 0) Text("No categories yet.")
    for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val meta = (0 until buckets.length()).map { buckets.getJSONObject(it) }.find { it.optString("id") == row.optString("bucketId") }
        if (meta?.optString("systemRole").isNullOrBlank().not()) continue
        var text by remember(row.optString("bucketId")) { mutableStateOf((row.optLong("assignedMinor") / 100.0).let { if (it == 0.0) "" else money(row.optLong("assignedMinor"), false).removePrefix("$") }) }
        Text("${row.optString("name")} available ${money(row.optLong("availableMinor"), privacy)} · ${meta?.optString("flexRole") ?: "category"}")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(text, { text = it }, label = { Text("Assigned") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
            Button(onClick = { onAssign(row.optString("bucketId"), parseDollars(text)) }) { Text("Save") }
        }
    }
}

@Composable
private fun ActivityTab(
    txns: JSONObject?,
    dash: JSONObject?,
    privacy: Boolean,
    activity: MainActivity,
    onMessage: (String) -> Unit,
    onSave: (JSONObject, ByteArray?) -> Unit,
    onUpdate: (String, JSONObject) -> Unit,
) {
    var payee by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var accountId by remember { mutableStateOf("") }
    var counterId by remember { mutableStateOf("") }
    var bucketId by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("expense") }
    var receipt by remember { mutableStateOf<ByteArray?>(null) }
    activity.onReceipt = { receipt = it }
    activity.onFile = { receipt = it }
    val accounts = dash?.optJSONArray("accounts") ?: JSONArray()
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    Text("New transaction", style = MaterialTheme.typography.titleMedium)
    Text("Choose the account. A new expense is not charged to the first account.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("expense", "income", "refund", "transfer", "cc_payment").forEach { choice ->
            TextButton(onClick = { type = choice }) { Text(if (type == choice) choice.replace('_', ' ').replaceFirstChar { it.titlecase() } else choice.replace('_', ' ')) }
        }
    }
    if (accounts.length() == 0) Text("Add an account from More before recording activity.")
    Text(if (accountId.isBlank()) "Account" else "Account selected")
    for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        TextButton(onClick = { accountId = account.optString("id") }) {
            Text(if (account.optString("id") == accountId) "Selected · ${account.optString("name")}" else account.optString("name"))
        }
    }
    if (type == "transfer" || type == "cc_payment") {
        Text("Other account")
        for (index in 0 until accounts.length()) {
            val account = accounts.getJSONObject(index)
            if (account.optString("id") == accountId) continue
            TextButton(onClick = { counterId = account.optString("id") }) {
                Text(if (account.optString("id") == counterId) "Selected · ${account.optString("name")}" else account.optString("name"))
            }
        }
    } else {
        Text("Category")
        TextButton(onClick = { bucketId = "" }) { Text(if (bucketId.isBlank()) "Selected · Uncategorized" else "Uncategorized") }
        for (index in 0 until buckets.length()) {
            val bucket = buckets.getJSONObject(index)
            if (bucket.optString("systemRole").isNotBlank()) continue
            val wanted = if (type == "income") "income" else "expense"
            if (bucket.optString("kind") != wanted) continue
            TextButton(onClick = { bucketId = bucket.optString("id") }) {
                Text(if (bucket.optString("id") == bucketId) "Selected · ${bucket.optString("name")}" else bucket.optString("name"))
            }
        }
    }
    OutlinedTextField(payee, { payee = it }, label = { Text("Payee") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { activity.captureReceipt() }) { Text(if (receipt == null) "Receipt photo" else "Photo ready") }
        TextButton(onClick = { activity.pickReceipt() }) { Text("Choose file") }
        Button(onClick = {
            if (payee.isBlank() || amount.isBlank()) { onMessage("Enter a payee and an amount."); return@Button }
            if (accountId.isBlank()) { onMessage("Choose an account before saving."); return@Button }
            if ((type == "transfer" || type == "cc_payment") && counterId.isBlank()) { onMessage("Choose the other account."); return@Button }
            val magnitude = kotlin.math.abs(parseDollars(amount))
            val signed = if (type == "income" || type == "refund") magnitude else -magnitude
            val splits = JSONArray()
            if (bucketId.isNotBlank() && type != "transfer" && type != "cc_payment") {
                val role = if (type == "income") "income" else if (type == "refund") "refund" else "expense"
                splits.put(JSONObject().put("bucketId", bucketId).put("amountMinor", magnitude).put("role", role))
            }
            val body = JSONObject()
                .put("date", LocalDate.now().toString())
                .put("accountId", accountId)
                .put("amountMinor", signed)
                .put("type", type)
                .put("payee", payee)
                .put("bankStatus", "posted")
                .put("categoryLocked", bucketId.isNotBlank())
                .put("splits", splits)
                .put("opId", UUID.randomUUID().toString())
            if (counterId.isNotBlank()) body.put("counterAccountId", counterId)
            onSave(body, receipt)
            payee = ""; amount = ""; receipt = null
        }) { Text("Save") }
    }
    Text("Receipt text is not read automatically.")
    val rows = txns?.optJSONArray("transactions")
    var selected by remember { mutableStateOf("") }
    Text("Activity", style = MaterialTheme.typography.titleMedium)
    if (rows == null) Text("Loading activity…")
    else if (rows.length() == 0) Text("No transactions yet.")
    else for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val id = row.optString("id")
        TextButton(onClick = { selected = if (selected == id) "" else id }, modifier = Modifier.fillMaxWidth()) {
            Text("${row.optString("date")}  ${row.optString("payee")}  ${money(row.optLong("amountMinor"), privacy)}  ${row.optString("reviewStatus").replace('_', ' ')}")
        }
        if (selected == id) TransactionEditor(row, onMessage) { patch -> onUpdate(id, patch) }
    }
}

@Composable
private fun TransactionEditor(row: JSONObject, onMessage: (String) -> Unit, onSave: (JSONObject) -> Unit) {
    val original = row.optLong("amountMinor")
    var payee by remember(row.optString("id")) { mutableStateOf(row.optString("payee")) }
    var amount by remember(row.optString("id")) { mutableStateOf(money(kotlin.math.abs(original), false).removePrefix("$")) }
    Text("Editing keeps the same direction. A reconciled amount change needs a reason on the web if this phone is refused.")
    OutlinedTextField(payee, { payee = it }, label = { Text("Payee") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        if (payee.isBlank()) { onMessage("Enter a payee."); return@Button }
        val magnitude = runCatching { parseDollars(amount) }.getOrElse { onMessage("Enter an amount like 12.50."); return@Button }
        val signed = if (original < 0) -kotlin.math.abs(magnitude) else kotlin.math.abs(magnitude)
        onSave(JSONObject().put("payee", payee).put("amountMinor", signed).put("version", if (row.has("version")) row.optInt("version") else 1))
    }) { Text("Update") }
}

@Composable
private fun WealthTab(dash: JSONObject?, privacy: Boolean, open: (String) -> Unit) {
    val worth = dash?.optJSONObject("netWorth")
    if (worth == null) { Text("Loading net worth…"); return }
    Text("Net ${money(worth.optLong("netMinor"), privacy)}", style = MaterialTheme.typography.headlineMedium)
    Text("Assets ${money(worth.optLong("assetsMinor"), privacy)} · Owed ${money(worth.optLong("liabilitiesMinor"), privacy)}")
    Text(worth.optString("formula"))
    val accounts = worth.optJSONArray("accounts")
    if (accounts == null || accounts.length() == 0) Text("No accounts are included in net worth yet.")
    else for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        Text("${account.optString("name")}  ${money(account.optLong("contributionMinor"), privacy)}")
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { open("investments") }) { Text("Investments") }
        TextButton(onClick = { open("retirement") }) { Text("Retirement") }
        TextButton(onClick = { open("reports") }) { Text("Reports") }
    }
}

@Composable
private fun MoreTab(store: Store, onTheme: (String) -> Unit, open: (String) -> Unit, reload: () -> Unit, signOut: () -> Unit) {
    var biometric by remember { mutableStateOf(store.biometric) }
    var privacy by remember { mutableStateOf(store.privacy) }
    Text("Waiting to sync: ${store.pendingForCurrentUser().size}")
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text("Biometric unlock", Modifier.weight(1f)); Switch(biometric, { biometric = it; store.biometric = it })
    }
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text("Hide amounts", Modifier.weight(1f)); Switch(privacy, { privacy = it; store.privacy = it; reload() })
    }
    Text("Theme")
    Row {
        listOf("system", "light", "dark").forEach { choice ->
            TextButton(onClick = { onTheme(choice) }) { Text(if (store.theme == choice) choice.replaceFirstChar { it.titlecase() } else choice) }
        }
    }
    listOf(
        "accounts" to "Accounts",
        "categories" to "Categories and envelopes",
        "bills" to "Bills and subscriptions",
        "paycheck" to "Paycheck plan",
        "goals" to "Goals",
        "debts" to "Debts",
        "forecast" to "Forecast",
        "investments" to "Investments",
        "retirement" to "Retirement",
        "reports" to "Reports",
        "rules" to "Rules",
        "household" to "Household",
        "connections" to "Connections",
        "security" to "Security",
        "learn" to "Learn",
        "assistant" to "Assistant",
        "import" to "Import",
    ).forEach { (id, label) ->
        TextButton(onClick = { open(id) }, modifier = Modifier.fillMaxWidth()) { Text(label) }
    }
    Text("Bank, credit, and negotiation connections stay disconnected until a provider is configured. The Connections screen shows each requirement.")
    TextButton(onClick = signOut) { Text("Sign out") }
}

private fun notifyAlerts(context: Context, dash: JSONObject) {
    val alerts = dash.optJSONArray("alerts") ?: return
    val unread = (0 until alerts.length()).map { alerts.getJSONObject(it) }.firstOrNull { it.isNull("readAt") && it.isNull("read_at") } ?: return
    val notification = NotificationCompat.Builder(context, "budgetcents")
        .setSmallIcon(R.drawable.ic_mark)
        .setContentTitle(unread.optString("title"))
        .setContentText(unread.optString("body"))
        .setAutoCancel(true)
        .build()
    context.getSystemService(NotificationManager::class.java).notify(42, notification)
}

private suspend fun flushQueue(api: BudgetApi, store: Store): Int = withContext(Dispatchers.IO) {
    val owner = store.userId ?: return@withContext 0
    if (store.token.isNullOrBlank()) return@withContext 0
    val queue = store.queued()
    val left = JSONArray()
    var sent = 0
    for (index in 0 until queue.length()) {
        val item = queue.getJSONObject(index)
        if (item.optString("ownerId") != owner) {
            left.put(item)
            continue
        }
        try {
            api.request("POST", item.getString("path"), JSONObject(item.getString("body")))
            sent += 1
        } catch (_: java.io.IOException) {
            left.put(item)
        } catch (error: ApiException) {
            if (error.status == 401 || error.status >= 500) left.put(item)
        } catch (_: Exception) {
            left.put(item)
        }
    }
    store.replaceQueue(left)
    sent
}

private fun tabIndex(host: String) = when (host) {
    "plan" -> 1
    "activity" -> 2
    "wealth", "investments", "retirement", "reports" -> 3
    "more", "accounts", "categories", "bills", "paycheck", "goals", "debts", "forecast", "rules", "household", "connections", "security", "learn", "assistant", "import" -> 4
    else -> 0
}

private fun subpage(host: String) = when (host) {
    "home", "plan", "activity", "wealth", "more" -> null
    else -> host
}
