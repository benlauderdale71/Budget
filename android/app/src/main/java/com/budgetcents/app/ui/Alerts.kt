package com.budgetcents.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.budgetcents.app.ApiException
import com.budgetcents.app.BudgetApi
import java.net.URLDecoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

@Composable
internal fun AlertsScreen(
    api: BudgetApi,
    hid: String,
    privacy: Boolean,
    onError: (String) -> Unit,
    onStatus: (String) -> Unit,
    onOpenPage: (String) -> Unit,
    onOpenTransactions: (String, String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var localError by remember { mutableStateOf("") }
    var conflict by remember { mutableStateOf("") }
    var settingsText by rememberSaveable { mutableStateOf("") }
    var version by rememberSaveable { mutableIntStateOf(1) }
    var dirty by rememberSaveable { mutableStateOf(false) }
    var timezone by rememberSaveable { mutableStateOf("UTC") }
    var frequency by rememberSaveable { mutableStateOf("immediate") }
    var quietEnabled by rememberSaveable { mutableStateOf(false) }
    var quietStart by rememberSaveable { mutableStateOf("22:00") }
    var quietEnd by rememberSaveable { mutableStateOf("07:00") }
    var digestEnabled by rememberSaveable { mutableStateOf(false) }
    var digestHour by rememberSaveable { mutableStateOf("8") }
    var snoozeHours by rememberSaveable { mutableStateOf("24") }
    var escalate by rememberSaveable { mutableStateOf(false) }
    var inApp by rememberSaveable { mutableStateOf(true) }
    var emailConsent by rememberSaveable { mutableStateOf(false) }
    var pushConsent by rememberSaveable { mutableStateOf(false) }
    var smsConsent by rememberSaveable { mutableStateOf(false) }
    var lowBalance by rememberSaveable { mutableStateOf("0.00") }
    var large by rememberSaveable { mutableStateOf("200.00") }
    var alerts by remember { mutableStateOf(JSONArray()) }
    var kinds by remember { mutableStateOf(JSONArray()) }
    var unsupported by remember { mutableStateOf(JSONArray()) }
    var channelNotes by remember { mutableStateOf(JSONArray()) }
    var typeStates by remember { mutableStateOf(mapOf<String, Boolean>()) }

    fun apply(result: JSONObject, replaceForm: Boolean) {
        alerts = result.optJSONArray("alerts") ?: alerts
        if (!replaceForm) return
        val settings = result.getJSONObject("settings")
        settingsText = settings.toString()
        version = result.optInt("version", version)
        timezone = settings.optString("timezone", timezone)
        frequency = settings.optString("frequency", frequency)
        val quiet = settings.optJSONObject("quietHours")
        quietEnabled = quiet?.optBoolean("enabled") ?: quietEnabled
        quietStart = quiet?.optString("start", quietStart) ?: quietStart
        quietEnd = quiet?.optString("end", quietEnd) ?: quietEnd
        val digest = settings.optJSONObject("digest")
        digestEnabled = digest?.optBoolean("enabled") ?: digestEnabled
        digestHour = (digest?.optInt("hour", digestHour.toIntOrNull() ?: 8) ?: 8).toString()
        snoozeHours = settings.optInt("snoozeHours", snoozeHours.toIntOrNull() ?: 24).toString()
        escalate = settings.optJSONObject("escalation")?.optBoolean("enabled") ?: escalate
        inApp = settings.optJSONObject("channels")?.optJSONObject("inapp")?.optBoolean("enabled") ?: inApp
        emailConsent = settings.optJSONObject("channels")?.optJSONObject("email")?.optBoolean("consent") ?: emailConsent
        pushConsent = settings.optJSONObject("channels")?.optJSONObject("push")?.optBoolean("consent") ?: pushConsent
        smsConsent = settings.optJSONObject("channels")?.optJSONObject("sms")?.optBoolean("consent") ?: smsConsent
        val thresholds = settings.optJSONObject("thresholds")
        if (!privacy && thresholds != null) {
            lowBalance = amountField(thresholds.optLong("lowBalanceMinor"))
            large = amountField(thresholds.optLong("largeTransactionMinor"))
        }
        val types = settings.optJSONObject("types") ?: JSONObject()
        val next = mutableMapOf<String, Boolean>()
        val keys = types.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            next[key] = types.optBoolean(key)
        }
        typeStates = next
        dirty = false
    }

    suspend fun reload(replaceForm: Boolean) {
        val settingsResult = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/alert-settings") }
        val alertResult = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/alerts") }
        kinds = settingsResult.optJSONArray("kinds") ?: JSONArray()
        unsupported = settingsResult.optJSONArray("unsupported") ?: JSONArray()
        channelNotes = settingsResult.optJSONArray("channels") ?: JSONArray()
        alerts = alertResult.optJSONArray("alerts") ?: JSONArray()
        apply(settingsResult.put("alerts", alerts), replaceForm && !dirty)
        localError = ""
    }

    LaunchedEffect(hid) {
        loading = true
        try {
            reload(true)
        } catch (caught: Exception) {
            localError = caught.message ?: "Alerts could not be loaded."
        } finally {
            loading = false
        }
    }

    if (loading && settingsText.isBlank() && alerts.length() == 0) {
        Text("Loading alerts…")
        return
    }
    if (localError.isNotBlank() && settingsText.isBlank()) {
        Text(localError)
        Text("You are offline or BudgetCents could not be reached. Alert history is not stored on this phone.")
        TextButton(onClick = { scope.launch { loading = true; try { reload(true) } catch (caught: Exception) { localError = caught.message ?: "Alerts could not be loaded." } finally { loading = false } } }) { Text("Try again") }
        return
    }
    if (localError.isNotBlank()) Text(localError)
    if (conflict.isNotBlank()) Text(conflict)

    Text("These settings are yours for this household. They do not change transactions or the plan.", style = MaterialTheme.typography.bodyMedium)
    if (dirty) Text("You have unsaved alert settings. A refresh will not replace them.")
    Button(onClick = {
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/alerts/check", JSONObject()) }
                alerts = result.optJSONArray("alerts") ?: JSONArray()
                onStatus("Checked the records you can see. Unchanged conditions were not alerted again.")
                localError = ""
            } catch (caught: Exception) {
                localError = caught.message ?: "The check did not finish."
                onError(localError)
            }
        }
    }, modifier = Modifier.fillMaxWidth()) { Text("Check now") }

    if (alerts.length() == 0) Text("No alerts. Check now looks at bills, balances, spending, goals, and expected pay you can see.")
    for (index in 0 until alerts.length()) {
        val alert = alerts.getJSONObject(index)
        val title = alert.optString("title")
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text("${alert.optString("status")} · ${alert.optString("deliveryStatus")}${if (alert.optBoolean("escalated")) " · Escalated in the app" else ""}")
        if (privacy) Text("Amount hidden.") else {
            Text(alert.optString("body"))
            if (!alert.isNull("amountMinor")) Text(money(alert.optLong("amountMinor"), false))
        }
        if (!alert.isNull("targetNote")) Text(alert.optString("targetNote"))
        val href = alert.optString("href")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (alert.optBoolean("targetAvailable") && href.isNotBlank()) {
                TextButton(onClick = { openAlertTarget(href, title, onOpenPage, onOpenTransactions) }) { Text("Open record") }
            }
            if (alert.optString("status") != "resolved") {
                TextButton(onClick = { scope.launch { postAlert(api, hid, alert.optString("id"), "read", onError) { alerts = it } } }) { Text("Mark read") }
                TextButton(onClick = { scope.launch { postAlert(api, hid, alert.optString("id"), "snooze", onError, JSONObject().put("hours", snoozeHours.toIntOrNull() ?: 24)) { alerts = it } } }) { Text("Snooze") }
                TextButton(onClick = { scope.launch { postAlert(api, hid, alert.optString("id"), "resolve", onError) { alerts = it } } }) { Text("Resolve") }
            }
        }
    }

    Text("Settings", style = MaterialTheme.typography.titleMedium)
    kinds.let { rows ->
        for (index in 0 until rows.length()) {
            val kind = rows.getJSONObject(index)
            val id = kind.optString("id")
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(kind.optString("label"), modifier = Modifier.weight(1f))
                Switch(typeStates[id] == true, {
                    typeStates = typeStates.toMutableMap().apply { put(id, it) }
                    dirty = true
                })
            }
        }
    }
    if (privacy) Text("Amounts are hidden on this device. Show amounts before editing a threshold.")
    else {
        OutlinedTextField(lowBalance, { lowBalance = it; dirty = true }, label = { Text("Low balance at or below") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(large, { large = it; dirty = true }, label = { Text("Large transaction at or above") }, modifier = Modifier.fillMaxWidth())
    }
    OutlinedTextField(timezone, { timezone = it; dirty = true }, label = { Text("Time zone") }, modifier = Modifier.fillMaxWidth())
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Quiet hours", modifier = Modifier.weight(1f))
        Switch(quietEnabled, { quietEnabled = it; dirty = true })
    }
    OutlinedTextField(quietStart, { quietStart = it; dirty = true }, label = { Text("Quiet start HH:mm") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(quietEnd, { quietEnd = it; dirty = true }, label = { Text("Quiet end HH:mm") }, modifier = Modifier.fillMaxWidth())
    Text("A start later than the end crosses midnight.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { frequency = "immediate"; dirty = true }) { Text(if (frequency == "immediate") "Immediate" else "Choose immediate") }
        TextButton(onClick = { frequency = "digest"; digestEnabled = true; dirty = true }) { Text(if (frequency == "digest") "Digest" else "Choose digest") }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Digest schedule", modifier = Modifier.weight(1f))
        Switch(digestEnabled, { digestEnabled = it; if (!it) frequency = "immediate"; dirty = true })
    }
    OutlinedTextField(digestHour, { digestHour = it; dirty = true }, label = { Text("Digest hour") }, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(snoozeHours, { snoozeHours = it; dirty = true }, label = { Text("Snooze hours") }, modifier = Modifier.fillMaxWidth())
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Escalate unread in-app alerts", modifier = Modifier.weight(1f))
        Switch(escalate, { escalate = it; dirty = true })
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("In-app alerts", modifier = Modifier.weight(1f))
        Switch(inApp, { inApp = it; dirty = true })
    }
    channelNotes.let { rows ->
        for (index in 0 until rows.length()) {
            val channel = rows.getJSONObject(index)
            if (channel.optString("id") == "inapp") continue
            Text("${channel.optString("id").replaceFirstChar { it.titlecase() }} is ${if (channel.optBoolean("available")) "available" else "unavailable"}. ${channel.optString("reason")}")
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Remember email consent", modifier = Modifier.weight(1f)); Switch(emailConsent, { emailConsent = it; dirty = true })
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Remember push consent", modifier = Modifier.weight(1f)); Switch(pushConsent, { pushConsent = it; dirty = true })
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Remember text consent", modifier = Modifier.weight(1f)); Switch(smsConsent, { smsConsent = it; dirty = true })
    }
    Text("Consent does not send email, remote push, or text. A notification shown by this app is local.")
    Button(onClick = {
        scope.launch {
            try {
                val settings = JSONObject(settingsText.ifBlank { "{}" })
                settings.put("timezone", timezone.trim())
                settings.put("frequency", frequency)
                settings.put("snoozeHours", snoozeHours.toInt())
                val quiet = settings.optJSONObject("quietHours") ?: JSONObject()
                quiet.put("enabled", quietEnabled).put("start", quietStart.trim()).put("end", quietEnd.trim())
                settings.put("quietHours", quiet)
                val digest = settings.optJSONObject("digest") ?: JSONObject()
                digest.put("enabled", digestEnabled).put("hour", digestHour.toInt())
                settings.put("digest", digest)
                val escalation = settings.optJSONObject("escalation") ?: JSONObject()
                escalation.put("enabled", escalate)
                settings.put("escalation", escalation)
                val channels = settings.optJSONObject("channels") ?: JSONObject()
                channels.put("inapp", JSONObject().put("enabled", inApp))
                channels.put("push", JSONObject().put("consent", pushConsent))
                channels.put("email", JSONObject().put("consent", emailConsent))
                channels.put("sms", JSONObject().put("consent", smsConsent))
                settings.put("channels", channels)
                val types = settings.optJSONObject("types") ?: JSONObject()
                typeStates.forEach { (key, value) -> types.put(key, value) }
                settings.put("types", types)
                if (!privacy) {
                    val thresholds = settings.optJSONObject("thresholds") ?: JSONObject()
                    thresholds.put("lowBalanceMinor", parseDollars(lowBalance))
                    thresholds.put("largeTransactionMinor", parseDollars(large))
                    settings.put("thresholds", thresholds)
                }
                val saved = withContext(Dispatchers.IO) {
                    api.request("PUT", "/api/households/$hid/alert-settings", JSONObject().put("version", version).put("settings", settings))
                }
                apply(saved.put("alerts", alerts), true)
                conflict = ""
                onStatus("Alert settings saved for this household.")
            } catch (caught: ApiException) {
                if (caught.status == 409) conflict = caught.message ?: "These alert settings were saved somewhere else."
                else onError(caught.message ?: "Alert settings were not saved.")
            } catch (caught: Exception) {
                localError = caught.message ?: "Alert settings were not saved."
                onError(localError)
            }
        }
    }, modifier = Modifier.fillMaxWidth()) { Text("Save alert settings") }
    if (conflict.isNotBlank()) {
        TextButton(onClick = { scope.launch { try { reload(true); conflict = ""; dirty = false } catch (caught: Exception) { onError(caught.message ?: "Could not reload alert settings.") } } }) { Text("Load saved settings") }
    }
    Text("Not available from the ledger", style = MaterialTheme.typography.titleMedium)
    for (index in 0 until unsupported.length()) Text(unsupported.getJSONObject(index).optString("reason"))
}

private suspend fun postAlert(api: BudgetApi, hid: String, id: String, action: String, onError: (String) -> Unit, body: JSONObject = JSONObject(), onAlerts: (JSONArray) -> Unit) {
    try {
        withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/alerts/$id/$action", body) }
        val listed = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/alerts") }
        onAlerts(listed.optJSONArray("alerts") ?: JSONArray())
    } catch (caught: Exception) {
        onError(caught.message ?: "That alert was not updated.")
    }
}

private fun openAlertTarget(href: String, title: String, onOpenPage: (String) -> Unit, onOpenTransactions: (String, String) -> Unit) {
    if (href.contains("/activity")) {
        val ids = URLDecoder.decode(href.substringAfter("ids=").substringBefore("&"), "UTF-8")
        if (ids.isNotBlank()) onOpenTransactions(ids, title)
        return
    }
    val page = when {
        href.contains("/bills") -> "bills"
        href.contains("/goals") -> "goals"
        href.contains("/accounts") -> "accounts"
        href.contains("/forecast") -> "forecast"
        href.contains("/paychecks") -> "paycheck"
        href.contains("/plan") -> "categories"
        else -> ""
    }
    if (page.isNotBlank()) onOpenPage(page)
}
