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
fun BudgetApp(activity: MainActivity, start: String, linkToken: String? = null) {
    val context = LocalContext.current
    val store = remember { Store(context.applicationContext) }
    val api = remember { BudgetApi(store) }
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf(store.token) }
    var locked by remember { mutableStateOf(store.biometric && store.token != null) }
    var tab by remember { mutableIntStateOf(tabIndex(start)) }
    var page by remember { mutableStateOf(subpage(start)) }
    var openSetup by remember { mutableStateOf(start == "setup") }
    var error by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var dash by remember { mutableStateOf<JSONObject?>(null) }
    var txns by remember { mutableStateOf<JSONObject?>(null) }
    var activityIds by remember { mutableStateOf<String?>(null) }
    var activityLabel by remember { mutableStateOf("") }
    var themeName by remember { mutableStateOf(store.theme) }
    var inviteToken by remember {
        val incoming = if (start == "invite") linkToken else null
        if (!incoming.isNullOrBlank()) store.pendingInvite = incoming
        mutableStateOf(if (!incoming.isNullOrBlank()) incoming else store.pendingInvite)
    }
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
                val flush = flushQueue(api, store)
                val loaded = withContext(Dispatchers.IO) { api.dashboard(hid) }
                val activityRows = withContext(Dispatchers.IO) {
                    val ids = activityIds
                    if (ids.isNullOrBlank()) api.transactions(hid)
                    else {
                        val encoded = java.net.URLEncoder.encode(ids, "UTF-8")
                        api.request("GET", "/api/households/$hid/transactions?ids=$encoded&limit=200")
                    }
                }
                dash = loaded
                txns = activityRows
                val guidance = loaded.getJSONObject("guidance")
                val short = guidance.optString("primaryFigure") == "shortage"
                val amount = if (short) guidance.optLong("shortageMinor") else guidance.optLong("cashSafeMinor")
                val label = if (short) "Short" else "Safe to spend"
                store.summary = "$label ${money(amount, store.privacy)}"
                refreshWidgets(context)
                notifyAlerts(context, loaded)
                if (flush.rejected.isNotBlank()) error = flush.rejected
                else if (flush.sent > 0) status = "Synced ${flush.sent}. Balances were refreshed."
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
            SignIn(store, api, error, start, linkToken, { openSetup = true }) { message ->
                if (message != null) error = message else {
                    token = store.token
                    themeName = store.theme
                    error = ""
                    inviteToken = store.pendingInvite
                    if (!store.pendingInvite.isNullOrBlank()) {
                        page = "invite"
                        openSetup = false
                    } else if (openSetup) {
                        page = "setup"
                        tab = 4
                        openSetup = false
                    }
                    reload()
                }
            }
            return@MaterialTheme
        }
        if (store.householdId.isNullOrBlank()) {
            Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!inviteToken.isNullOrBlank()) {
                    InviteScreen(api, store, inviteToken!!, { _ -> page = null; reload() }, {
                        store.pendingInvite = null
                        inviteToken = null
                    }, {
                        store.clearSession()
                        token = null
                    }) { error = it }
                } else {
                    Text("You are signed in without a household. Open an invitation, or sign out and create one.")
                    TextButton(onClick = { store.clearSession(); token = null }) { Text("Sign out") }
                }
                if (error.isNotBlank()) Text(error)
            }
            return@MaterialTheme
        }
        LaunchedEffect(linkToken) {
            if (start == "verify" && !linkToken.isNullOrBlank()) {
                try {
                    withContext(Dispatchers.IO) {
                        api.request("POST", "/api/auth/verify-email", JSONObject().put("token", linkToken), auth = false)
                    }
                    if (!store.pendingInvite.isNullOrBlank()) {
                        status = "Email verified. The invitation stays pending until you accept it."
                        page = "invite"
                    } else {
                        status = "Email verified. Setup continues from the saved step."
                        page = "setup"
                        tab = 4
                    }
                } catch (caught: Exception) {
                    error = caught.message ?: "That verification link did not work."
                }
            }
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
                    val householdRole = dash?.optJSONObject("household")?.optString("role") ?: ""
                    if (!writesAllowed(householdRole) && householdRole.isNotBlank()) {
                        Text("${roleTitle(householdRole)} access can view shared records. It cannot change household money. Your dashboard, privacy, and security settings stay yours.")
                    }
                    if (page == "invite" && !inviteToken.isNullOrBlank()) {
                        InviteScreen(api, store, inviteToken!!, { accepted ->
                            if (accepted.isNotBlank()) store.householdId = accepted
                            page = null
                            reload()
                        }, {
                            store.pendingInvite = null
                            inviteToken = null
                            page = null
                        }, {
                            store.clearSession()
                            token = null
                            page = null
                        }) { error = it }
                    } else if (page != null) {
                        FeatureScreen(page!!, api, store, dash, store.privacy, { page = null }, { reload() }, { error = it }, { error = ""; status = it }, {
                            store.clearSession(); token = null; dash = null; txns = null; page = null; activityIds = null; activityLabel = ""
                        }, { name ->
                            themeName = name
                            store.theme = name
                        }, activity) { ids, label ->
                            activityIds = ids
                            activityLabel = label
                            page = null
                            tab = 2
                            reload()
                        }
                    } else when (tab) {
                        0 -> DashboardHome(dash, store.privacy, api, store, LocalConfiguration.current.screenWidthDp)
                        1 -> PlanTab(dash, store.privacy, plansAllowed(householdRole), { bucketId, amount ->
                            scope.launch {
                                runCatching {
                                    withContext(Dispatchers.IO) {
                                        api.assign(store.householdId!!, JSONObject().put("spaceId", dash?.optString("spaceId")).put("bucketId", bucketId).put("periodKey", dash?.getJSONObject("budget")?.optString("periodKey")).put("amountMinor", amount))
                                    }
                                }.onSuccess { reload() }.onFailure { error = it.message ?: "Could not assign." }
                            }
                        }) { fromId, toId, amount ->
                            scope.launch {
                                runCatching {
                                    withContext(Dispatchers.IO) {
                                        api.request("POST", "/api/households/${store.householdId}/move", JSONObject()
                                            .put("spaceId", dash?.optString("spaceId"))
                                            .put("fromBucketId", fromId)
                                            .put("toBucketId", toId)
                                            .put("periodKey", dash?.getJSONObject("budget")?.optString("periodKey"))
                                            .put("amountMinor", amount))
                                    }
                                }.onSuccess { status = "Moved. No bank transaction was created."; reload() }.onFailure { error = it.message ?: "Could not move money." }
                            }
                        }
                        2 -> ActivityTab(txns, dash, store.privacy, writesAllowed(householdRole), activityIds != null, activityLabel, {
                            activityIds = null
                            activityLabel = ""
                            reload()
                        }, activity, { message -> error = message }, { body, receipt ->
                            scope.launch {
                                try {
                                    if (!body.has("opId")) body.put("opId", UUID.randomUUID().toString())
                                    val created = withContext(Dispatchers.IO) { api.createTransaction(store.householdId!!, body) }
                                    if (receipt != null && created.has("id")) {
                                        withContext(Dispatchers.IO) { api.uploadReceipt(store.householdId!!, created.getString("id"), receipt) }
                                        error = "Receipt saved. Open Receipts to read it. The amount you typed was not changed."
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
                        }, { id, patch ->
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { api.request("PATCH", "/api/households/${store.householdId}/transactions/$id", patch) }
                                    status = "Transaction updated."
                                    reload()
                                } catch (caught: Exception) {
                                    error = caught.message ?: "Could not update that transaction."
                                }
                            }
                        }, { id ->
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { api.request("POST", "/api/households/${store.householdId}/transactions/$id/duplicate", JSONObject()) }
                                    status = "A copy was added and marked for review. The original was not changed."
                                    reload()
                                } catch (caught: Exception) { error = caught.message ?: "Could not duplicate." }
                            }
                        }) { keeper, other ->
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { api.request("POST", "/api/households/${store.householdId}/transactions/$keeper/match", JSONObject().put("otherId", other)) }
                                    status = "Matched. One copy left the totals."
                                    reload()
                                } catch (caught: Exception) { error = caught.message ?: "Could not match those transactions." }
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
                            store.clearSession(); token = null; dash = null; txns = null; page = null; activityIds = null; activityLabel = ""
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SignIn(
    store: Store,
    api: BudgetApi,
    error: String,
    start: String,
    linkToken: String?,
    onRegistered: () -> Unit,
    done: (String?) -> Unit,
) {
    var base by remember { mutableStateOf(store.baseUrl) }
    var mode by remember { mutableStateOf(if (start == "reset" || start == "verify" || start == "invite") start else "login") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var household by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var tokenText by remember { mutableStateOf(linkToken ?: "") }
    var mfa by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var mail by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("BudgetCents", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
        Text("Same household as the web app. The emulator reaches a computer at 10.0.2.2.", color = Ink)
        OutlinedTextField(base, { base = it }, label = { Text("Server") }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("login" to "Sign in", "invite" to "Join a household", "register" to "Create household", "reset" to "Reset password", "verify" to "Verify email").forEach { (id, label) ->
                TextButton(onClick = { mode = id; note = "" }) { Text(label) }
            }
        }
        if (mode == "register" || mode == "invite") {
            OutlinedTextField(name, { name = it }, label = { Text("Your name") }, modifier = Modifier.fillMaxWidth())
            if (mode == "invite") Text("This account joins an existing household. It does not create a new one. Accept the invitation after you verify your email.")
            else OutlinedTextField(household, { household = it }, label = { Text("Household name") }, modifier = Modifier.fillMaxWidth())
        }
        if (mode != "verify") OutlinedTextField(email, { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
        if (mode == "login" || mode == "register" || mode == "reset" || mode == "invite") {
            OutlinedTextField(password, { password = it }, label = { Text(if (mode == "reset") "New password" else "Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        }
        if (mode == "reset") {
            OutlinedTextField(confirm, { confirm = it }, label = { Text("Confirm password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(tokenText, { tokenText = it }, label = { Text("Reset token") }, modifier = Modifier.fillMaxWidth())
            Text("The reset request does not say whether the email exists. Open the link, or paste its token. SMTP delivery is not active.")
        }
        if (mode == "verify") {
            OutlinedTextField(tokenText, { tokenText = it }, label = { Text("Verification token") }, modifier = Modifier.fillMaxWidth())
            Text("An unverified account can keep setting up. Invitations stay closed until this link is used.")
        }
        if (mfa) OutlinedTextField(code, { code = it }, label = { Text("Authentication code") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
        if (error.isNotBlank()) Text(error)
        if (note.isNotBlank()) Text(note)
        if (mail.isNotBlank()) Text(mail)
        Button(onClick = {
            store.baseUrl = base
            scope.launch {
                try {
                    when (mode) {
                        "register", "invite" -> {
                            if (password.length < 10) { note = "Use at least 10 characters."; return@launch }
                            val body = JSONObject()
                                .put("email", email.trim())
                                .put("password", password)
                                .put("displayName", name.trim())
                            if (mode == "register") body.put("householdName", household.trim())
                            val result = withContext(Dispatchers.IO) { api.request("POST", "/api/auth/register", body, auth = false) }
                            adoptSession(api, store, result)
                            if (store.pendingInvite.isNullOrBlank()) onRegistered()
                            done(null)
                        }
                        "reset" -> {
                            if (tokenText.isBlank()) {
                                val result = withContext(Dispatchers.IO) {
                                    api.request("POST", "/api/auth/forgot", JSONObject().put("email", email.trim()), auth = false)
                                }
                                note = result.optString("message")
                                return@launch
                            }
                            if (password != confirm) { note = "Enter the same password in both fields."; return@launch }
                            if (password.length < 10) { note = "Use at least 10 characters."; return@launch }
                            withContext(Dispatchers.IO) {
                                api.request("POST", "/api/auth/reset", JSONObject().put("token", tokenText.trim()).put("password", password), auth = false)
                            }
                            note = "Password updated. Sign in with the new one."
                            mode = "login"
                            password = ""
                            confirm = ""
                        }
                        "verify" -> {
                            val result = withContext(Dispatchers.IO) {
                                api.request("POST", "/api/auth/verify-email", JSONObject().put("token", tokenText.trim()), auth = false)
                            }
                            note = if (!store.pendingInvite.isNullOrBlank()) "Email verified. The invitation stays pending until you accept it." else "Email verified. Sign in to continue from ${result.optString("onboardingStep", "the saved step")}."
                        }
                        else -> {
                            val result = withContext(Dispatchers.IO) { api.login(email.trim(), password, code.ifBlank { null }) }
                            if (result.optBoolean("mfaRequired")) {
                                mfa = true
                                note = "Enter the code from your authenticator or a recovery code."
                                return@launch
                            }
                            adoptSession(api, store, result)
                            val step = result.optJSONObject("user")?.optString("onboardingStep")
                            if (step != "done") onRegistered()
                            done(null)
                        }
                    }
                } catch (caught: Exception) {
                    done(caught.message ?: "Could not sign in.")
                }
            }
        }, modifier = Modifier.fillMaxWidth()) { Text(if (mode == "register") "Create household" else if (mode == "invite") "Create account" else if (mode == "reset") "Continue" else if (mode == "verify") "Verify email" else "Sign in") }
        TextButton(onClick = {
            store.baseUrl = base
            scope.launch {
                try {
                    val result = withContext(Dispatchers.IO) {
                        api.request("GET", "/api/dev/outbox?email=${java.net.URLEncoder.encode(email.trim(), "UTF-8")}", auth = false)
                    }
                    val messages = result.optJSONArray("messages") ?: org.json.JSONArray()
                    mail = (0 until messages.length()).joinToString("\n\n") { messages.getJSONObject(it).optString("body") }.ifBlank { "No message is waiting for that address." }
                    note = result.optString("note")
                } catch (caught: Exception) {
                    mail = ""
                    note = if (caught is ApiException && caught.status == 404) "Development mail is off." else caught.message ?: "Could not read development mail."
                }
            }
        }) { Text("Show development mail") }
        TextButton(onClick = {
            store.baseUrl = base
            scope.launch { sign(api, store, done) { api.demo() } }
        }) { Text("Open the sample household") }
        Text("Development mail is the local outbox. It is not SMTP delivery. Deleting the app does not delete the server account.")
    }
}

private suspend fun adoptSession(api: BudgetApi, store: Store, result: JSONObject) {
    store.token = result.getString("token")
    val user = result.optJSONObject("user")
    if (user != null) {
        store.userId = user.getString("id")
        store.theme = user.optString("theme", store.theme)
    }
    val homes = withContext(Dispatchers.IO) { api.households() }
    val list = homes.optJSONArray("households")
    store.householdId = if (list == null || list.length() == 0) null else list.getJSONObject(0).optString("id").ifBlank { null }
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
        val list = homes.optJSONArray("households")
        store.householdId = if (list == null || list.length() == 0) null else list.getJSONObject(0).optString("id").ifBlank { null }
        done(null)
    } catch (caught: Exception) {
        done(caught.message ?: "Could not sign in.")
    }
}


@Composable
private fun PlanTab(dash: JSONObject?, privacy: Boolean, writes: Boolean, onAssign: (String, Long) -> Unit, onMove: (String, String, Long) -> Unit) {
    if (dash == null) { Text("Loading the plan…"); return }
    val buckets = dash.getJSONArray("buckets")
    val rows = dash.getJSONObject("budget").getJSONArray("buckets")
    Text("Available is cash already assigned. Expected pay is not included, and a move does not create a bank transaction.")
    if (!writes) Text("This role can view the plan. It cannot assign or move money.")
    var fromId by remember { mutableStateOf("") }
    var toId by remember { mutableStateOf("") }
    var moveText by remember { mutableStateOf("") }
    var moveError by remember { mutableStateOf("") }
    Text("Move between categories", style = MaterialTheme.typography.titleMedium)
    if (rows.length() == 0) Text("No categories yet.")
    for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val meta = (0 until buckets.length()).map { buckets.getJSONObject(it) }.find { it.optString("id") == row.optString("bucketId") }
        if (meta?.optString("systemRole").isNullOrBlank().not()) continue
        val bucketId = row.optString("bucketId")
        var text by remember(bucketId) { mutableStateOf((row.optLong("assignedMinor") / 100.0).let { if (it == 0.0) "" else money(row.optLong("assignedMinor"), false).removePrefix("$") }) }
        Text("${row.optString("name")} available ${money(row.optLong("availableMinor"), privacy)} · ${meta?.optString("flexRole") ?: "category"}")
        if (writes) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text, { text = it }, label = { Text("Assigned") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.weight(1f))
                Button(onClick = { onAssign(bucketId, parseDollars(text)) }) { Text("Save") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { fromId = bucketId }) { Text(if (fromId == bucketId) "From this" else "From") }
                TextButton(onClick = { toId = bucketId }) { Text(if (toId == bucketId) "To this" else "To") }
            }
        }
    }
    if (!writes) return
    OutlinedTextField(moveText, { moveText = it }, label = { Text("Amount to move") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        val amount = runCatching { parseDollars(moveText) }.getOrDefault(0)
        if (fromId.isBlank() || toId.isBlank() || fromId == toId) { moveError = "Choose two different categories."; return@Button }
        if (amount <= 0) { moveError = "Enter an amount to move."; return@Button }
        moveError = ""
        onMove(fromId, toId, amount)
        moveText = ""
    }) { Text("Move") }
    if (moveError.isNotBlank()) Text(moveError)
}

@Composable
private fun ActivityTab(
    txns: JSONObject?,
    dash: JSONObject?,
    privacy: Boolean,
    writes: Boolean,
    filtered: Boolean,
    filterLabel: String,
    onShowRegister: () -> Unit,
    activity: MainActivity,
    onMessage: (String) -> Unit,
    onSave: (JSONObject, ByteArray?) -> Unit,
    onUpdate: (String, JSONObject) -> Unit,
    onDuplicate: (String) -> Unit,
    onMatch: (String, String) -> Unit,
) {
    var payee by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var accountId by remember { mutableStateOf("") }
    var counterId by remember { mutableStateOf("") }
    var bucketId by remember { mutableStateOf("") }
    var type by remember { mutableStateOf("expense") }
    var notes by remember { mutableStateOf("") }
    var receipt by remember { mutableStateOf<ByteArray?>(null) }
    activity.onReceipt = { receipt = it }
    activity.onFile = { receipt = it }
    val accounts = dash?.optJSONArray("accounts") ?: JSONArray()
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    if (!writes) Text("This role can view activity. It cannot add, edit, duplicate, or match transactions.")
    if (writes) {
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
    OutlinedTextField(notes, { notes = it }, label = { Text("Note") }, modifier = Modifier.fillMaxWidth())
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
                .put("notes", notes)
                .put("opId", UUID.randomUUID().toString())
            if (counterId.isNotBlank()) body.put("counterAccountId", counterId)
            onSave(body, receipt)
            payee = ""; amount = ""; notes = ""; receipt = null
        }) { Text("Save") }
    }
    Text("The photo is stored after you save. Open Receipts to read it. Saving here does not change the amount.")
    }
    val rows = txns?.optJSONArray("transactions")
    var selected by remember { mutableStateOf("") }
    var matchId by remember { mutableStateOf("") }
    Text("Activity", style = MaterialTheme.typography.titleMedium)
    if (filtered) {
        Text("Showing $filterLabel from the report. Other register rows are hidden.")
        TextButton(onClick = onShowRegister) { Text("Show the whole register") }
    }
    if (txns != null) Text("Showing ${rows?.length() ?: 0} of ${txns.optInt("total")}.")
    if (rows == null) Text("Loading activity…")
    else if (rows.length() == 0) Text(if (filtered) "No transactions in that report row." else "No transactions yet.")
    else for (index in 0 until rows.length()) {
        val row = rows.getJSONObject(index)
        val id = row.optString("id")
        TextButton(onClick = { selected = if (selected == id) "" else id }, modifier = Modifier.fillMaxWidth()) {
            Text("${row.optString("date")}  ${row.optString("payee")}  ${money(row.optLong("amountMinor"), privacy)}  ${row.optString("reviewStatus").replace('_', ' ')}")
        }
        if (selected == id && writes) {
            TransactionEditor(row, accounts, buckets, onMessage) { patch -> onUpdate(id, patch) }
            if (writes) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { onDuplicate(id) }) { Text("Duplicate") }
                TextButton(onClick = { matchId = if (matchId == id) "" else id }) { Text(if (matchId == id) "Selected to match" else "Match") }
                if (matchId.isNotBlank() && matchId != id) TextButton(onClick = { onMatch(matchId, id); matchId = "" }) { Text("Match with selected") }
            }
        }
    }
}

@Composable
private fun TransactionEditor(row: JSONObject, accounts: JSONArray, buckets: JSONArray, onMessage: (String) -> Unit, onSave: (JSONObject) -> Unit) {
    val original = row.optLong("amountMinor")
    var payee by remember(row.optString("id")) { mutableStateOf(row.optString("payee")) }
    var amount by remember(row.optString("id")) { mutableStateOf(money(kotlin.math.abs(original), false).removePrefix("$")) }
    var type by remember(row.optString("id")) { mutableStateOf(row.optString("type", "expense")) }
    var accountId by remember(row.optString("id")) { mutableStateOf(row.optString("accountId")) }
    var notes by remember(row.optString("id")) { mutableStateOf(row.optString("notes")) }
    var tags by remember(row.optString("id")) { mutableStateOf(row.optJSONArray("tags")?.let { array -> (0 until array.length()).joinToString(", ") { array.optString(it) } } ?: "") }
    val initialSplits = row.optJSONArray("splits")
    var drafts by remember(row.optString("id")) {
        mutableStateOf(
            if (initialSplits == null || initialSplits.length() == 0) listOf(SplitDraft("", ""))
            else (0 until initialSplits.length()).map { splitIndex ->
                val split = initialSplits.getJSONObject(splitIndex)
                SplitDraft(split.optString("bucketId"), money(kotlin.math.abs(split.optLong("amountMinor")), false).removePrefix("$"))
            },
        )
    }
    var activeSplit by remember(row.optString("id")) { mutableIntStateOf(0) }
    Text("A version conflict asks you to reload. Matching notes, tags, and receipts stay on the record you keep.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("expense", "income", "refund", "transfer", "cc_payment").forEach { choice ->
            TextButton(onClick = { type = choice }) { Text(if (type == choice) choice.replace('_', ' ').replaceFirstChar { it.titlecase() } else choice.replace('_', ' ')) }
        }
    }
    for (index in 0 until accounts.length()) {
        val account = accounts.getJSONObject(index)
        TextButton(onClick = { accountId = account.optString("id") }) {
            Text(if (account.optString("id") == accountId) "Account · ${account.optString("name")}" else account.optString("name"))
        }
    }
    if (type != "transfer" && type != "cc_payment") {
        Text("Splits")
        drafts.forEachIndexed { splitIndex, draft ->
            TextButton(onClick = { activeSplit = splitIndex }) { Text(if (activeSplit == splitIndex) "Editing split ${splitIndex + 1}" else "Split ${splitIndex + 1}") }
            OutlinedTextField(draft.amount, { value -> drafts = drafts.mapIndexed { index, item -> if (index == splitIndex) item.copy(amount = value) else item } }, label = { Text("Split ${splitIndex + 1} amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            if (activeSplit == splitIndex) {
                TextButton(onClick = { drafts = drafts.mapIndexed { index, item -> if (index == splitIndex) item.copy(bucketId = "") else item } }) { Text(if (draft.bucketId.isBlank()) "Category · Uncategorized" else "Uncategorized") }
                for (index in 0 until buckets.length()) {
                    val bucket = buckets.getJSONObject(index)
                    if (bucket.optString("systemRole").isNotBlank()) continue
                    TextButton(onClick = { drafts = drafts.mapIndexed { itemIndex, item -> if (itemIndex == splitIndex) item.copy(bucketId = bucket.optString("id")) else item } }) {
                        Text(if (bucket.optString("id") == draft.bucketId) "Category · ${bucket.optString("name")}" else bucket.optString("name"))
                    }
                }
            }
        }
        TextButton(onClick = { drafts = drafts + SplitDraft("", ""); activeSplit = drafts.lastIndex }) { Text("Add split") }
    }
    OutlinedTextField(payee, { payee = it }, label = { Text("Payee") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(amount, { amount = it }, label = { Text("Amount") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(notes, { notes = it }, label = { Text("Note") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(tags, { tags = it }, label = { Text("Tags") }, modifier = Modifier.fillMaxWidth())
    Button(onClick = {
        if (payee.isBlank() || accountId.isBlank()) { onMessage("Enter a payee and choose an account."); return@Button }
        val magnitude = runCatching { parseDollars(amount) }.getOrElse { onMessage("Enter an amount like 12.50."); return@Button }
        if (magnitude == 0L && type != "reconciliation") { onMessage("Enter an amount other than zero."); return@Button }
        val signed = if (type == "income" || type == "refund") kotlin.math.abs(magnitude) else if (type == "expense") -kotlin.math.abs(magnitude) else if (original < 0) -kotlin.math.abs(magnitude) else kotlin.math.abs(magnitude)
        val splits = JSONArray()
        if (type != "transfer" && type != "cc_payment") {
            for (draft in drafts) {
                if (draft.amount.isBlank() && draft.bucketId.isBlank()) continue
                val splitMagnitude = runCatching { parseDollars(if (draft.amount.isBlank()) money(kotlin.math.abs(signed), false).removePrefix("$") else draft.amount) }.getOrElse { onMessage("Enter a split amount like 12.50."); return@Button }
                if (splitMagnitude == 0L) continue
                val item = JSONObject().put("amountMinor", kotlin.math.abs(splitMagnitude)).put("role", if (type == "income") "income" else if (type == "refund") "refund" else "expense")
                if (draft.bucketId.isNotBlank()) item.put("bucketId", draft.bucketId)
                splits.put(item)
            }
        }
        val patch = JSONObject()
            .put("payee", payee)
            .put("amountMinor", signed)
            .put("type", type)
            .put("accountId", accountId)
            .put("notes", notes)
            .put("tags", JSONArray(tags.split(",").map { it.trim() }.filter { it.isNotEmpty() }))
            .put("splits", splits)
            .put("categoryLocked", drafts.any { it.bucketId.isNotBlank() })
            .put("version", if (row.has("version")) row.optInt("version") else 1)
        onSave(patch)
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
        "setup" to "Setup",
        "accounts" to "Accounts",
        "categories" to "Categories and envelopes",
        "fills" to "Envelope fills",
        "bills" to "Bills and subscriptions",
        "paycheck" to "Paychecks",
        "calendar" to "Calendar",
        "incomeplan" to "Category plan",
        "goals" to "Goals",
        "debts" to "Debts",
        "forecast" to "Forecast",
        "receipts" to "Receipts",
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

private data class SplitDraft(val bucketId: String, val amount: String)

private data class FlushResult(val sent: Int, val rejected: String)

private suspend fun flushQueue(api: BudgetApi, store: Store): FlushResult = withContext(Dispatchers.IO) {
    val owner = store.userId ?: return@withContext FlushResult(0, "")
    if (store.token.isNullOrBlank()) return@withContext FlushResult(0, "")
    val queue = store.queued()
    val left = JSONArray()
    var sent = 0
    var rejected = ""
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
            else rejected = error.message ?: "A saved transaction was rejected and was not sent again."
        } catch (_: Exception) {
            left.put(item)
        }
    }
    store.replaceQueue(left)
    FlushResult(sent, rejected)
}

private fun tabIndex(host: String) = when (host) {
    "plan" -> 1
    "activity" -> 2
    "wealth", "investments", "retirement", "reports" -> 3
    "more", "setup", "accounts", "categories", "fills", "bills", "paycheck", "calendar", "incomeplan", "goals", "debts", "forecast", "rules", "household", "connections", "security", "learn", "assistant", "import" -> 4
    else -> 0
}

private fun subpage(host: String) = when (host) {
    "home", "plan", "activity", "wealth", "more" -> null
    else -> host
}
