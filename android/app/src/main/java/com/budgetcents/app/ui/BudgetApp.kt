package com.budgetcents.app.ui

import android.app.NotificationManager
import android.content.Context
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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationCompat
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.MainActivity
import com.budgetcents.app.R
import com.budgetcents.app.Store
import com.budgetcents.app.widget.refreshWidgets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate

private val Teal = Color(0xFF0C6B63)
private val Ink = Color(0xFF152033)

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
    var error by remember { mutableStateOf("") }
    var dash by remember { mutableStateOf<JSONObject?>(null) }
    var txns by remember { mutableStateOf<JSONObject?>(null) }

    fun reload() {
        val hid = store.householdId ?: return
        scope.launch {
            error = ""
            try {
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
                flushQueue(api, store)
            } catch (caught: Exception) {
                error = caught.message ?: "Could not reach BudgetCents."
            }
        }
    }

    MaterialTheme(colorScheme = lightColorScheme(primary = Teal, onPrimary = Color.White, background = Color(0xFFF3F6F4))) {
        if (token == null) {
            SignIn(store, api, error) { message ->
                if (message != null) error = message else { token = store.token; error = ""; reload() }
            }
            return@MaterialTheme
        }
        if (locked) {
            Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("BudgetCents", style = MaterialTheme.typography.headlineMedium, color = Teal)
                Text("Unlock this device to see the household.")
                Button(onClick = { activity.unlock({ locked = false; reload() }, { error = it }) }) { Text("Unlock") }
                if (error.isNotBlank()) Text(error)
            }
            return@MaterialTheme
        }
        LaunchedEffect(token) { reload() }
        Scaffold(bottomBar = {
            NavigationBar {
                listOf("Home", "Plan", "Activity", "Wealth", "More").forEachIndexed { index, label ->
                    NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = {}, label = { Text(label) })
                }
            }
        }) { padding ->
            Column(Modifier.padding(padding).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (error.isNotBlank()) Text(error, color = Color(0xFF8F3D32))
                val loaded = dash
                when (tab) {
                    0 -> HomeTab(loaded, store.privacy)
                    1 -> PlanTab(loaded, store.privacy) { bucketId, amount ->
                        scope.launch { runCatching { withContext(Dispatchers.IO) { api.assign(store.householdId!!, JSONObject().put("spaceId", loaded?.optString("spaceId")).put("bucketId", bucketId).put("periodKey", loaded?.getJSONObject("budget")?.optString("periodKey")).put("amountMinor", amount)) } }.onSuccess { reload() }.onFailure { error = it.message ?: "Could not assign." } }
                    }
                    2 -> ActivityTab(txns, loaded, store.privacy, activity) { body, receipt ->
                        scope.launch {
                            try {
                                val created = withContext(Dispatchers.IO) { api.createTransaction(store.householdId!!, body) }
                                if (receipt != null) {
                                    withContext(Dispatchers.IO) { api.uploadReceipt(store.householdId!!, created.getString("id"), receipt) }
                                    error = "Receipt saved. OCR is not connected, so the amount you typed was not changed."
                                }
                                reload()
                            } catch (caught: Exception) {
                                if (caught is java.io.IOException) {
                                    store.enqueue("/api/households/${store.householdId}/transactions", body.toString())
                                    error = "Offline. The transaction stays on this phone until the server is reachable."
                                } else error = caught.message ?: "Could not save."
                            }
                        }
                    }
                    3 -> WealthTab(loaded, store.privacy)
                    else -> MoreTab(store, { reload() }) {
                        store.clearSession(); token = null; dash = null
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
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("BudgetCents", style = MaterialTheme.typography.headlineMedium, color = Teal)
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
    Text(if (short) "Short before upcoming bills" else "Safe to spend", color = Teal)
    Text(money(if (short) guidance.optLong("shortageMinor") else guidance.optLong("cashSafeMinor"), privacy), style = MaterialTheme.typography.headlineLarge)
    Text(guidance.optString("formula"))
    Text("Ready to Assign ${money(budget.optLong("readyToAssignMinor"), privacy)}")
    Text("Net worth ${money(worth.optLong("netMinor"), privacy)}")
    if (budget.optLong("identityDifferenceMinor") != 0L) Text("The plan does not match cash. Review it before assigning more.")
    if (dash.optJSONObject("household")?.optBoolean("isDemo") == true) Text("Sample household. These figures are fictional.")
}

@Composable
private fun PlanTab(dash: JSONObject?, privacy: Boolean, onAssign: (String, Long) -> Unit) {
    if (dash == null) { Text("Loading the plan…"); return }
    val buckets = dash.getJSONArray("buckets")
    val rows = dash.getJSONObject("budget").getJSONArray("buckets")
    Text("Assign cash that has already arrived. Expected pay is not included.")
    for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val meta = (0 until buckets.length()).map { buckets.getJSONObject(it) }.find { it.optString("id") == row.optString("bucketId") }
        if (meta?.optString("systemRole").isNullOrBlank().not() && meta?.optString("systemRole") != "null") continue
        var text by remember(row.optString("bucketId")) { mutableStateOf(dollars(row.optLong("assignedMinor"))) }
        Text(row.optString("name") + " available " + money(row.optLong("availableMinor"), privacy))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(text, { text = it }, label = { Text("Assigned") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
            Button(onClick = { onAssign(row.optString("bucketId"), parseDollars(text)) }) { Text("Save") }
        }
    }
}

@Composable
private fun ActivityTab(txns: JSONObject?, dash: JSONObject?, privacy: Boolean, activity: MainActivity, onSave: (JSONObject, ByteArray?) -> Unit) {
    var payee by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var receipt by remember { mutableStateOf<ByteArray?>(null) }
    activity.onReceipt = { receipt = it }
    Text("New expense")
    OutlinedTextField(payee, { payee = it }, label = { Text("Payee") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { activity.captureReceipt() }) { Text(if (receipt == null) "Receipt photo" else "Photo ready") }
        Button(onClick = {
            val account = dash?.optJSONArray("accounts")?.optJSONObject(0)?.optString("id") ?: return@Button
            val body = JSONObject()
                .put("date", LocalDate.now().toString())
                .put("accountId", account)
                .put("amountMinor", -kotlin.math.abs(parseDollars(amount)))
                .put("type", "expense")
                .put("payee", payee)
                .put("bankStatus", "posted")
                .put("splits", org.json.JSONArray())
            onSave(body, receipt)
            payee = ""; amount = ""; receipt = null
        }) { Text("Save") }
    }
    Text("Receipt text is not read automatically.")
    val rows = txns?.optJSONArray("transactions")
    if (rows == null) Text("Loading activity…") else for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        Text("${row.optString("date")}  ${row.optString("payee")}  ${money(row.optLong("amountMinor"), privacy)}")
    }
}

@Composable
private fun WealthTab(dash: JSONObject?, privacy: Boolean) {
    val worth = dash?.optJSONObject("netWorth")
    if (worth == null) { Text("Loading net worth…"); return }
    Text("Net ${money(worth.optLong("netMinor"), privacy)}", style = MaterialTheme.typography.headlineMedium)
    Text("Assets ${money(worth.optLong("assetsMinor"), privacy)} · Owed ${money(worth.optLong("liabilitiesMinor"), privacy)}")
    Text(worth.optString("formula"))
    val accounts = worth.optJSONArray("accounts") ?: return
    for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        Text("${account.optString("name")}  ${money(account.optLong("contributionMinor"), privacy)}")
    }
}

@Composable
private fun MoreTab(store: Store, reload: () -> Unit, signOut: () -> Unit) {
    var biometric by remember { mutableStateOf(store.biometric) }
    var privacy by remember { mutableStateOf(store.privacy) }
    Text("Waiting to sync: ${store.queued().length()}")
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text("Biometric unlock", Modifier.weight(1f)); Switch(biometric, { biometric = it; store.biometric = it })
    }
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text("Hide amounts", Modifier.weight(1f)); Switch(privacy, { privacy = it; store.privacy = it; reload() })
    }
    Text("Bank, credit, and negotiation connections are not live on this build. The web app shows each provider’s setup requirement.")
    TextButton(onClick = signOut) { Text("Sign out") }
}

private fun notifyAlerts(context: Context, dash: JSONObject) {
    val alerts = dash.optJSONArray("alerts") ?: return
    val unread = (0 until alerts.length()).map { alerts.getJSONObject(it) }.firstOrNull { it.isNull("read_at") } ?: return
    val notification = NotificationCompat.Builder(context, "budgetcents")
        .setSmallIcon(R.drawable.ic_mark)
        .setContentTitle(unread.optString("title"))
        .setContentText(unread.optString("body"))
        .setAutoCancel(true)
        .build()
    context.getSystemService(NotificationManager::class.java).notify(42, notification)
}

private fun flushQueue(api: BudgetApi, store: Store) {
    val queue = store.queued()
    val left = org.json.JSONArray()
    for (index in 0 until queue.length()) {
        val item = queue.getJSONObject(index)
        try { api.request("POST", item.getString("path"), JSONObject(item.getString("body"))) } catch (_: java.io.IOException) { left.put(item) }
    }
    store.replaceQueue(left)
}

private fun tabIndex(host: String) = when (host) { "plan" -> 1; "activity" -> 2; "wealth" -> 3; else -> 0 }
private fun money(minor: Long, hidden: Boolean) = if (hidden) "••••" else "%,.2f".format(minor / 100.0).let { "$$it" }
private fun dollars(minor: Long) = BigDecimal(minor).movePointLeft(2).stripTrailingZeros().toPlainString()
private fun parseDollars(text: String): Long = BigDecimal(text.trim().ifBlank { "0" }.replace("$", "").replace(",", "")).movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact()
