package com.budgetcents.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.Store
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

private fun reviewAllowed(role: String) = writesAllowed(role) || role in listOf("coach", "planner", "accountant")
private fun peopleRows(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }

@Composable
private fun PersonChoice(label: String, value: String, choices: List<Pair<String, String>>, enabled: Boolean = true, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
            Text("$label: ${choices.find { it.first == value }?.second ?: "Choose a person"}")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            choices.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { open = false; onSelect(id) }) }
        }
    }
}

@Composable
internal fun OwnershipPanel(api: BudgetApi, store: Store, dash: JSONObject?, privacy: Boolean, refreshKey: String,
    reportIds: String? = null, onRows: ((JSONObject?) -> Unit)? = null) {
    val hid = store.householdId ?: return
    val space = dash?.optString("spaceId") ?: return
    var view by remember(hid, space) { mutableStateOf("all") }
    var person by remember(hid, space) { mutableStateOf("") }
    var queue by remember(hid, space) { mutableStateOf("") }
    var offset by remember(hid, space) { mutableIntStateOf(0) }
    var people by remember(hid) { mutableStateOf(JSONArray()) }
    var summary by remember(hid, space) { mutableStateOf<JSONObject?>(null) }
    var page by remember(hid, space) { mutableStateOf<JSONObject?>(null) }
    var error by remember(hid) { mutableStateOf("") }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(hid, space, view, person, queue, offset, reportIds, refreshKey, retry) {
        summary = null; page = null; error = ""; onRows?.invoke(null)
        try {
            val result = withContext(Dispatchers.IO) {
                val roster = api.request("GET", "/api/households/$hid/collaboration/people").getJSONArray("people")
                val query = "ownership=$view&spaceId=${URLEncoder.encode(space, "UTF-8")}" +
                    if (view == "yours") "&personId=${URLEncoder.encode(person, "UTF-8")}" else ""
                val totals = api.request("GET", "/api/households/$hid/ownership-summary?$query")
                val rows = if (onRows == null) null else api.request("GET", "/api/households/$hid/transactions?$query&limit=25&offset=$offset" +
                    (if (queue.isBlank()) "" else "&reviewer=$queue&review=needs_review") +
                    (if (reportIds == null) "" else "&ids=${URLEncoder.encode(reportIds, "UTF-8")}"))
                Triple(roster, totals, rows)
            }
            people = result.first; summary = result.second; page = result.third; onRows?.invoke(result.third)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (caught: Exception) { error = caught.message ?: "Could not load ownership activity." }
    }
    val others = peopleRows(people).filter { it.optString("id") != store.userId }
    Text("Household ownership activity", style = MaterialTheme.typography.titleMedium)
    PersonChoice("View", view, listOf("all" to "All visible records", "mine" to "Mine", "ours" to "Ours") +
        (if (others.isEmpty()) emptyList() else listOf("yours" to "Yours — another member"))) {
        view = it; offset = 0
        if (it == "yours" && others.none { row -> row.optString("id") == person }) person = others.first().optString("id")
    }
    if (view == "yours") PersonChoice("Whose records", person, others.map { it.optString("id") to it.optString("displayName") }) { person = it; offset = 0 }
    if (onRows != null) PersonChoice("Reviews", queue, listOf("" to "All reviews", "mine" to "Assigned to me", "unassigned" to "Unassigned")) { queue = it; offset = 0 }
    Text("Ownership labels keep existing account permissions. Ours means shared ownership.")
    if (error.isNotBlank()) { Text(error); TextButton(onClick = { retry++ }) { Text("Retry ownership activity") } }
    else if (summary == null) Text("Loading ownership activity.")
    else {
        val totals = summary!!
        Text("${totals.optString("from")} through ${totals.optString("to")}")
        Text("Posted income ${money(totals.optLong("incomeMinor"), privacy)} · Spending after refunds ${money(totals.optLong("spendingMinor"), privacy)} · Needs review ${totals.optInt("reviewCount")}")
        Text("The shared plan's cash and assignments stay combined. The plan cards show the full visible plan.")
    }
    if (onRows != null && page != null) {
        if (offset > 0) TextButton(onClick = { offset = maxOf(0, offset - 25) }) { Text("Previous page") }
        if (!page!!.isNull("nextOffset")) TextButton(onClick = { offset = page!!.optInt("nextOffset") }) { Text("Next page") }
    }
}

@Composable
internal fun TransactionPeople(row: JSONObject, api: BudgetApi, store: Store, role: String, onChanged: () -> Unit) {
    val hid = store.householdId ?: return
    val scope = rememberCoroutineScope()
    var people by remember(hid) { mutableStateOf(JSONArray()) }
    var owner by remember(row.toString()) { mutableStateOf(row.optString("ownerUserId")) }
    var reviewer by remember(row.toString()) { mutableStateOf(row.optString("reviewerUserId")) }
    var busy by remember { mutableStateOf(false) }
    var message by remember(row.toString()) { mutableStateOf("") }
    var loaded by remember(hid) { mutableStateOf(false) }
    LaunchedEffect(hid, row.toString()) {
        loaded = false
        try { people = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/collaboration/people").getJSONArray("people") }; loaded = true }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (caught: Exception) { message = caught.message ?: "Could not load household members." }
    }
    val roster = peopleRows(people)
    fun name(id: String) = roster.find { it.optString("id") == id }?.optString("displayName") ?: "Former member"
    fun save(path: String, body: JSONObject) {
        if (busy) return
        busy = true; message = ""
        scope.launch {
            try {
                withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/transactions/${row.optString("id")}/$path", body.put("version", row.optInt("version", 1))) }
                message = "Saved. Money did not change."; onChanged()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (caught: Exception) { message = caught.message ?: "Could not save. Reload Activity before retrying." }
            finally { busy = false }
        }
    }
    Text("Owner: ${if (row.optString("ownerUserId").isBlank()) "Ours" else name(row.optString("ownerUserId"))}")
    if (row.optString("reviewerUserId").isNotBlank()) Text("Reviewer: ${name(row.optString("reviewerUserId"))}")
    if (row.optString("reviewResolvedAt").isNotBlank()) Text("Resolved by ${name(row.optString("reviewResolvedBy"))} on ${row.optString("reviewResolvedAt").take(10)}")
    if (writesAllowed(role)) {
        Text("Ownership filters views. Assigning a reviewer requests a new review. Neither grants private access.")
        PersonChoice("Owner", owner, listOf("" to "Ours — shared ownership") + roster.map { it.optString("id") to it.optString("displayName") }, loaded && !busy) { owner = it }
        Button(enabled = loaded && !busy, onClick = { save("ownership", JSONObject().put("ownerUserId", if (owner.isBlank()) JSONObject.NULL else owner)) }) { Text("Save ownership") }
        PersonChoice("Reviewer", reviewer, listOf("" to "Unassigned") + roster.filter { reviewAllowed(it.optString("role")) }.map { it.optString("id") to it.optString("displayName") }, loaded && !busy) { reviewer = it }
        Button(enabled = loaded && !busy, onClick = { save("review-assignment", JSONObject().put("reviewerUserId", if (reviewer.isBlank()) JSONObject.NULL else reviewer)) }) { Text("Save reviewer") }
    }
    if (reviewAllowed(role) && (writesAllowed(role) || row.optString("reviewerUserId").isBlank() || row.optString("reviewerUserId") == store.userId)) {
        val done = row.optString("reviewStatus") == "reviewed"
        Button(enabled = !busy, onClick = { save("review", JSONObject().put("reviewStatus", if (done) "needs_review" else "reviewed")) }) { Text(if (done) "Reopen review" else "Mark reviewed") }
    }
    if (message.isNotBlank()) Text(message)
}
