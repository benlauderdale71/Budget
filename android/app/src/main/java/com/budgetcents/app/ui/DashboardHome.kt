package com.budgetcents.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import com.budgetcents.app.ApiException
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private data class DashSpec(val id: String, val label: String, val wide: Boolean)

private data class DashCard(val id: String, val hidden: Boolean, val size: String)

private data class LayoutRetry(val cards: List<DashCard>, val mode: String, val message: String)

private val DASH_SPECS = listOf(
    DashSpec("safe", "Safe to spend", false),
    DashSpec("ready", "Ready to Assign", false),
    DashSpec("worth", "Net worth", false),
    DashSpec("age", "Age of money", false),
    DashSpec("committed", "Already given a job", false),
    DashSpec("bill", "Next bill", false),
    DashSpec("review", "Needs review", false),
    DashSpec("goals", "Goals", false),
    DashSpec("month", "This month", true),
    DashSpec("upcoming", "Upcoming", true),
    DashSpec("alerts", "Alerts", true),
    DashSpec("recent", "Recent", true),
)

private fun dashLabel(id: String) = DASH_SPECS.find { it.id == id }?.label ?: "Card"

private fun dashDefaults() = DASH_SPECS.map { DashCard(it.id, false, if (it.wide) "wide" else "standard") }

private fun dashDeviceClass(widthDp: Int) = if (widthDp <= 860) "android-compact" else "android-expanded"

private fun dashRead(layout: JSONObject?, widthDp: Int): Pair<Int, List<DashCard>> {
    if (layout == null) return 0 to dashDefaults()
    val revision = layout.optInt("revision", 0)
    val layouts = layout.optJSONObject("layouts") ?: return revision to dashDefaults()
    val array = layouts.optJSONArray(dashDeviceClass(widthDp)) ?: return revision to dashDefaults()
    val parsed = mutableListOf<DashCard>()
    val seen = mutableSetOf<String>()
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val id = item.optString("id")
        val spec = DASH_SPECS.find { it.id == id } ?: continue
        if (!seen.add(id)) continue
        val requested = item.optString("size")
        val size = when {
            requested == "wide" && spec.wide -> "wide"
            requested == "standard" -> "standard"
            spec.wide -> "wide"
            else -> "standard"
        }
        parsed += DashCard(id, item.optBoolean("hidden", false), size)
    }
    DASH_SPECS.forEach { spec ->
        if (parsed.none { it.id == spec.id }) parsed += DashCard(spec.id, false, if (spec.wide) "wide" else "standard")
    }
    return revision to parsed
}

private fun dashJson(cards: List<DashCard>): JSONArray {
    val array = JSONArray()
    cards.forEach { card -> array.put(JSONObject().put("id", card.id).put("hidden", card.hidden).put("size", card.size)) }
    return array
}

private fun dashMove(cards: List<DashCard>, id: String, direction: Int): List<DashCard> {
    val items = cards.toMutableList()
    val index = items.indexOfFirst { it.id == id }
    val target = index + direction
    if (index < 0 || target !in items.indices) return cards
    val item = items.removeAt(index)
    items.add(target, item)
    return items
}

private fun dashRows(cards: List<DashCard>, columns: Int): List<List<DashCard>> {
    val visible = cards.filter { !it.hidden }
    if (columns <= 1) return visible.map { listOf(it) }
    val rows = mutableListOf<List<DashCard>>()
    val row = mutableListOf<DashCard>()
    visible.forEach { card ->
        if (card.size == "wide") {
            if (row.isNotEmpty()) rows += row.toList()
            row.clear()
            rows += listOf(card)
        } else {
            row += card
            if (row.size == columns) {
                rows += row.toList()
                row.clear()
            }
        }
    }
    if (row.isNotEmpty()) rows += row.toList()
    return rows
}

@Composable
fun DashboardHome(dash: JSONObject?, privacy: Boolean, api: BudgetApi, store: Store, widthDp: Int) {
    val scope = rememberCoroutineScope()
    val deviceClass = dashDeviceClass(widthDp)
    val compact = widthDp <= 860
    var layout by remember { mutableStateOf<JSONObject?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    var cards by remember { mutableStateOf(dashDefaults()) }
    var status by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var customizing by remember { mutableStateOf(false) }
    var retry by remember { mutableStateOf<LayoutRetry?>(null) }
    val stacks = remember { mutableStateMapOf<String, List<List<DashCard>>>() }
    val undoFocus = remember { FocusRequester() }
    val past = stacks[deviceClass].orEmpty()

    LaunchedEffect(store.userId) {
        stacks.clear()
        retry = null
        try {
            val me = withContext(Dispatchers.IO) { api.request("GET", "/api/me") }
            layout = me.optJSONObject("user")?.optJSONObject("dashboardLayout")
        } catch (_: Exception) {
            status = "The dashboard layout could not be loaded. These cards were not saved."
        }
    }
    LaunchedEffect(layout, widthDp) {
        if (saving) return@LaunchedEffect
        val read = dashRead(layout, widthDp)
        revision = read.first
        cards = read.second
    }

    fun save(next: List<DashCard>, mode: String, message: String) {
        if (saving) return
        val owner = store.userId
        val previous = cards
        val klass = deviceClass
        val expected = revision
        scope.launch {
            saving = true
            retry = null
            status = "Saving the dashboard layout."
            try {
                val body = JSONObject().put(
                    "dashboardLayout",
                    JSONObject().put("deviceClass", klass).put("revision", expected).put("cards", dashJson(next)),
                )
                val response = withContext(Dispatchers.IO) { api.request("PATCH", "/api/me", body) }
                if (store.userId != owner || owner.isNullOrBlank()) return@launch
                val user = response.optJSONObject("user")
                layout = user?.optJSONObject("dashboardLayout")
                val read = dashRead(layout, widthDp)
                revision = read.first
                cards = read.second
                val stack = stacks[klass].orEmpty()
                stacks[klass] = if (mode == "undo") stack.dropLast(1) else (stack + listOf(previous)).takeLast(20)
                status = "$message Dashboard layout saved."
                if (mode == "undo") runCatching { undoFocus.requestFocus() }
            } catch (caught: Exception) {
                val conflict = caught is ApiException && caught.status == 409
                if (conflict) {
                    stacks.remove(klass)
                    status = "This layout changed somewhere else. The change was not saved."
                    val me = runCatching { withContext(Dispatchers.IO) { api.request("GET", "/api/me") } }.getOrNull()
                    layout = me?.optJSONObject("user")?.optJSONObject("dashboardLayout") ?: layout
                    val read = dashRead(layout, widthDp)
                    revision = read.first
                    cards = read.second
                } else {
                    retry = LayoutRetry(next, mode, message)
                    status = "Could not save the dashboard layout. This change was not saved."
                }
            } finally {
                saving = false
            }
        }
    }

    if (dash == null) {
        Text("Loading the household…")
        return
    }
    val guidance = dash.getJSONObject("guidance")
    val budget = dash.getJSONObject("budget")
    if (budget.optLong("identityDifferenceMinor") != 0L) {
        Text("The plan does not match cash. Review it before assigning more.")
    }
    if (dash.optJSONObject("household")?.optBoolean("isDemo") == true) Text("Sample household. These figures are fictional.")
    if (status.isNotBlank()) {
        Text(status, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        if (retry != null) TextButton(onClick = { save(retry!!.cards, retry!!.mode, retry!!.message) }, enabled = !saving) { Text("Try again") }
    }
    Text("This layout is saved for this sign-in on this screen size. It does not change a balance, and it is not added to the offline transaction list.")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { customizing = !customizing }) { Text(if (customizing) "Close dashboard layout" else "Customize dashboard") }
        TextButton(
            onClick = {
                val snapshot = past.lastOrNull() ?: return@TextButton
                save(snapshot, "undo", "Previous dashboard layout restored.")
            },
            enabled = !saving && past.isNotEmpty(),
            modifier = Modifier.focusRequester(undoFocus),
        ) { Text("Undo dashboard layout") }
    }
    if (customizing) {
        TextButton(onClick = { save(dashDefaults(), "change", "Dashboard layout reset.") }, enabled = !saving) { Text("Reset layout") }
        cards.forEachIndexed { index, card ->
            val label = dashLabel(card.id)
            Text(if (card.hidden) "$label, hidden" else label)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = { save(dashMove(cards, card.id, -1), "change", "$label moved up.") }, enabled = !saving && index > 0) { Text("Move $label up") }
                TextButton(onClick = { save(dashMove(cards, card.id, 1), "change", "$label moved down.") }, enabled = !saving && index < cards.lastIndex) { Text("Move $label down") }
                if (card.hidden) TextButton(onClick = { save(cards.map { if (it.id == card.id) it.copy(hidden = false) else it }, "change", "$label restored.") }, enabled = !saving) { Text("Restore $label") }
                else TextButton(onClick = { save(cards.map { if (it.id == card.id) it.copy(hidden = true) else it }, "change", "$label hidden.") }, enabled = !saving) { Text("Hide $label") }
            }
            val spec = DASH_SPECS.find { it.id == card.id }
            if (spec?.wide == true) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { save(cards.map { if (it.id == card.id) it.copy(size = "standard") else it }, "change", "$label is Standard.") }, enabled = !saving && card.size != "standard") { Text("Change $label card size to Standard") }
                    TextButton(onClick = { save(cards.map { if (it.id == card.id) it.copy(size = "wide") else it }, "change", "$label is Wide.") }, enabled = !saving && card.size != "wide") { Text("Change $label card size to Wide") }
                }
                if (compact) Text("Wide is saved for a wider screen. This screen shows the card in one column.")
            }
        }
    }
    dashRows(cards, if (compact) 1 else 2).forEach { row ->
        if (row.size == 1 && (compact || row[0].size == "wide")) {
            Column(Modifier.fillMaxWidth()) { DashCardBody(row[0], dash, privacy, guidance, budget) }
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { card -> Column(Modifier.weight(1f)) { DashCardBody(card, dash, privacy, guidance, budget) } }
            }
        }
    }
}

@Composable
private fun DashCardBody(card: DashCard, dash: JSONObject, privacy: Boolean, guidance: JSONObject, budget: JSONObject) {
    val worth = dash.optJSONObject("netWorth")
    val short = guidance.optString("primaryFigure") == "shortage"
    val committed = budget.optLong("claimsMinor") - budget.optLong("readyToAssignMinor") - budget.optLong("futureAssignedMinor")
    when (card.id) {
        "safe" -> {
            Text(if (short) "Short before upcoming bills" else "Safe to spend", color = MaterialTheme.colorScheme.primary)
            Text(money(if (short) guidance.optLong("shortageMinor") else guidance.optLong("cashSafeMinor"), privacy), style = MaterialTheme.typography.headlineMedium)
            Text(guidance.optString("formula"))
        }
        "ready" -> {
            Text("Ready to Assign", color = MaterialTheme.colorScheme.primary)
            Text(money(budget.optLong("readyToAssignMinor"), privacy), style = MaterialTheme.typography.headlineMedium)
        }
        "worth" -> {
            Text("Net worth", color = MaterialTheme.colorScheme.primary)
            Text(money(worth?.optLong("netMinor") ?: 0L, privacy), style = MaterialTheme.typography.headlineMedium)
            Text("Liquid ${money(worth?.optLong("liquidMinor") ?: 0L, privacy)}")
        }
        "age" -> {
            val age = dash.optJSONObject("ageOfMoney")
            val days = if (age == null || age.isNull("days")) "Not enough history" else "${age.optInt("days")} days"
            Text("Age of money", color = MaterialTheme.colorScheme.primary)
            Text(days, style = MaterialTheme.typography.headlineMedium)
            if (age != null) Text(age.optString("formula"))
        }
        "committed" -> {
            Text("Already given a job", color = MaterialTheme.colorScheme.primary)
            Text(money(committed, privacy), style = MaterialTheme.typography.headlineMedium)
            Text("Cash sitting in categories, envelopes, and reserves.")
        }
        "bill" -> {
            Text("Next bill", color = MaterialTheme.colorScheme.primary)
            val upcoming = dash.optJSONArray("upcoming")
            val next = upcoming?.let { array ->
                (0 until array.length()).map { array.getJSONObject(it) }.firstOrNull { it.optLong("amountMinor") < 0 }
            }
            if (next == null) Text("No outflow is scheduled in the next month.")
            else Text("${next.optString("date")} ${next.optString("label")} ${money(next.optLong("amountMinor"), privacy)}")
        }
        "review" -> {
            Text("Needs review", color = MaterialTheme.colorScheme.primary)
            Text(dash.optInt("reviewCount").toString(), style = MaterialTheme.typography.headlineMedium)
        }
        "goals" -> {
            Text("Goals", color = MaterialTheme.colorScheme.primary)
            val goals = dash.optJSONArray("goals")
            if (goals == null || goals.length() == 0) Text("No goal is using an envelope yet.")
            else {
                val limit = minOf(3, goals.length())
                for (index in 0 until limit) {
                    val goal = goals.getJSONObject(index)
                    Text("${goal.optString("name")} ${money(goal.optLong("availableMinor"), privacy)} of ${money(goal.optLong("target_minor"), privacy)}")
                }
            }
        }
        "month" -> {
            Text("This month", style = MaterialTheme.typography.titleMedium)
            val rows = budget.optJSONArray("buckets")
            val metas = dash.optJSONArray("buckets")
            var shown = 0
            if (rows != null) {
                for (index in 0 until rows.length()) {
                    if (shown >= 8) break
                    val row = rows.getJSONObject(index)
                    val name = row.optString("name")
                    if (name == "Credit card payments" || name == "Borrowed funds") continue
                    val meta = (0 until (metas?.length() ?: 0)).map { metas!!.getJSONObject(it) }.find { it.optString("id") == row.optString("bucketId") }
                    if (meta?.optString("kind") != "expense") continue
                    shown += 1
                    Text("$name ${money(row.optLong("availableMinor"), privacy)}")
                }
            }
            if (shown == 0) Text("No spending categories yet.")
        }
        "upcoming" -> {
            Text("Upcoming", style = MaterialTheme.typography.titleMedium)
            val upcoming = dash.optJSONArray("upcoming")
            if (upcoming == null || upcoming.length() == 0) Text("Nothing scheduled in the next month.")
            else {
                val limit = minOf(6, upcoming.length())
                for (index in 0 until limit) {
                    val item = upcoming.getJSONObject(index)
                    val expected = if (item.optBoolean("expectedIncome")) " expected" else ""
                    Text("${item.optString("date")} ${item.optString("label")}$expected ${money(item.optLong("amountMinor"), privacy)}")
                }
            }
        }
        "alerts" -> {
            Text("Alerts", style = MaterialTheme.typography.titleMedium)
            val alerts = dash.optJSONArray("alerts")
            if (alerts == null || alerts.length() == 0) Text("No alerts.")
            else {
                val limit = minOf(4, alerts.length())
                for (index in 0 until limit) Text(alerts.getJSONObject(index).optString("title"))
            }
        }
        "recent" -> {
            Text("Recent", style = MaterialTheme.typography.titleMedium)
            val recent = dash.optJSONArray("recent")
            if (recent == null || recent.length() == 0) Text("No transactions yet.")
            else {
                val limit = minOf(5, recent.length())
                for (index in 0 until limit) {
                    val txn = recent.getJSONObject(index)
                    Text("${txn.optString("date")} ${txn.optString("payee")} ${money(txn.optLong("amountMinor"), privacy)}")
                }
            }
        }
    }
}
