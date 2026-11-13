package com.budgetcents.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.budgetcents.app.BudgetApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.util.UUID

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
private fun microShares(raw: String): Long {
    require(Regex("\\d+(\\.\\d{1,6})?").matches(raw)) { "Use at most six decimal places for shares." }
    return BigDecimal(raw).movePointRight(6).longValueExact()
}

@Composable
private fun FinanceField(label: String, value: String, change: (String) -> Unit) {
    OutlinedTextField(value, change, label = { Text(label) }, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun FinancePick(label: String, rows: List<JSONObject>, selected: String, id: String = "id", name: String = "name", change: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val chosen = rows.find { it.optString(id) == selected }
    TextButton(onClick = { expanded = !expanded }) { Text("$label: ${chosen?.optString(name) ?: "Choose"}") }
    if (expanded) rows.forEach { row -> TextButton(onClick = { change(row.optString(id)); expanded = false }) { Text(row.optString(name)) } }
}

@Composable
internal fun SimplefinScreen(api: BudgetApi, hid: String, privacy: Boolean, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var state by remember(hid) { mutableStateOf(JSONObject()) }
    var accounts by remember(hid) { mutableStateOf(listOf<JSONObject>()) }
    var purchases by remember(hid) { mutableStateOf(listOf<JSONObject>()) }
    var token by remember(hid) { mutableStateOf("") }
    var label by rememberSaveable(hid) { mutableStateOf("My bank") }
    var consent by remember(hid) { mutableStateOf(false) }
    var preview by remember(hid) { mutableStateOf<JSONObject?>(null) }
    var linkId by remember(hid) { mutableStateOf("") }
    var sourceId by remember(hid) { mutableStateOf("") }
    var targetId by remember(hid) { mutableStateOf("") }
    var rowId by remember(hid) { mutableStateOf("") }
    var kind by remember(hid) { mutableStateOf("expense") }
    var otherId by remember(hid) { mutableStateOf("") }
    var refundId by remember(hid) { mutableStateOf("") }
    var page by remember(hid) { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var note by remember(hid) { mutableStateOf("") }
    var disconnect by remember(hid) { mutableStateOf("") }
    suspend fun refresh() {
        val loaded = withContext(Dispatchers.IO) {
            Triple(api.request("GET", "/api/households/$hid/providers/simplefin"), api.request("GET", "/api/households/$hid/accounts"), api.request("GET", "/api/households/$hid/transactions?limit=500"))
        }
        state = loaded.first
        accounts = (loaded.second.optJSONArray("accounts") ?: JSONArray()).objects()
        purchases = (loaded.third.optJSONArray("transactions") ?: JSONArray()).objects().filter { it.optString("type") == "expense" }
    }
    fun act(work: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch { try { work() } catch (cancelled: CancellationException) { throw cancelled } catch (e: Exception) { note = e.message ?: "The connection could not finish." } finally { busy = false } }
    }
    LaunchedEffect(hid) { try { refresh() } catch (e: Exception) { note = e.message ?: "Could not load connections." } }
    Text("SimpleFIN bank connection", style = MaterialTheme.typography.titleLarge)
    Text("Get a setup token from SimpleFIN Bridge. Confirm America’s First Federal Credit Union (AmFirst) coverage before subscribing; it is not verified here. Enter bank passwords only with the provider.")
    if (state.optBoolean("configured")) {
        FinanceField("Connection name", label) { label = it }
        OutlinedTextField(token, { token = it }, label = { Text("SimpleFIN setup token") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        TextButton(onClick = { consent = !consent }) { Text(if (consent) "Bank read consent granted — revoke" else "Allow BudgetCents to read this bank feed") }
        Button(enabled = !busy && consent && token.isNotBlank(), onClick = { act {
            val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/providers/simplefin/connect", JSONObject().put("setupToken", token).put("label", label).put("consent", consent)) }
            token = ""; consent = false; note = result.optString("note"); refresh()
        } }) { Text("Connect bank feed") }
    } else Text("The server needs its bank encryption key configured. Manual entry and file imports are available.")
    (state.optJSONArray("links") ?: JSONArray()).objects().forEach { link ->
        Text(link.optString("label"))
        Button(enabled = !busy, onClick = { act {
            val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/providers/simplefin/${link.getString("id")}/preview", JSONObject()) }
            preview = result; linkId = link.getString("id"); sourceId = ""; rowId = ""; page = 0; note = result.optString("note")
        } }) { Text("Preview posted history") }
        TextButton(enabled = !busy, onClick = { disconnect = link.getString("id") }) { Text("Disconnect ${link.optString("label")}") }
    }
    if (disconnect.isNotBlank()) {
        Text("Disconnect this feed? Imported transactions stay in your register.")
        Button(enabled = !busy, onClick = { act {
            val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/providers/simplefin/$disconnect/revoke", JSONObject()) }
            disconnect = ""; preview = null; note = result.optString("note"); refresh()
        } }) { Text("Confirm disconnect") }
        TextButton(onClick = { disconnect = "" }) { Text("Keep connection") }
    }
    preview?.let { data ->
        Text("Preview expires in 15 minutes. Refreshes are cached for one hour. Import only history excluded from your opening balance and not already in the register. For a transfer, import one side only.")
        val warnings = data.optJSONArray("warnings") ?: JSONArray()
        for (i in 0 until warnings.length()) Text(warnings.optString(i))
        val bankAccounts = (data.optJSONArray("accounts") ?: JSONArray()).objects()
        FinancePick("Bank account", bankAccounts, sourceId, "externalAccountId") { sourceId = it; rowId = ""; targetId = ""; page = 0 }
        bankAccounts.find { it.optString("externalAccountId") == sourceId }?.let { source ->
            val currency = source.optString("currency")
            if (currency != "USD") Text("Use the web import for this $currency account. Android bank import currently supports USD.")
            else {
                FinancePick("Ledger account", accounts.filter { it.optString("currency") == currency }, targetId) { targetId = it }
                val rows = (source.optJSONArray("rows") ?: JSONArray()).objects()
                rows.drop(page * 20).take(20).forEach { row ->
                    TextButton(enabled = !busy && row.optString("status") == "new", onClick = { rowId = row.getString("externalId"); kind = if (row.optLong("amountMinor") < 0) "expense" else "income"; otherId = ""; refundId = "" }) {
                        Text("${if (rowId == row.optString("externalId")) "Selected · " else ""}${row.optString("date")} · ${row.optString("payee")} · ${money(row.optLong("amountMinor"), privacy)} · ${row.optString("status")}")
                    }
                }
                if (page > 0) TextButton(onClick = { page-- }) { Text("Previous transactions") }
                if ((page + 1) * 20 < rows.size) TextButton(onClick = { page++ }) { Text("Next transactions") }
                if (rowId.isNotBlank()) {
                    listOf("expense", "income", "refund", "transfer").forEach { option -> TextButton(onClick = { kind = option }) { Text(if (kind == option) "Selected: $option" else option) } }
                    if (kind == "transfer") FinancePick("Other account", accounts.filter { it.optString("id") != targetId && it.optString("currency") == currency }, otherId) { otherId = it }
                    if (kind == "refund") FinancePick("Original purchase", purchases.filter { it.optString("currency") == currency }.map { JSONObject(it.toString()).put("name", "${it.optString("date")} · ${it.optString("payee")}") }, refundId) { refundId = it }
                    Button(enabled = !busy && targetId.isNotBlank() && (kind != "transfer" || otherId.isNotBlank()) && (kind != "refund" || refundId.isNotBlank()), onClick = { act {
                        val selection = JSONObject().put("externalId", rowId).put("type", kind)
                        if (kind == "transfer") selection.put("counterAccountId", otherId)
                        if (kind == "refund") selection.put("refundOfId", refundId)
                        val body = JSONObject().put("previewId", data.getString("previewId")).put("externalAccountId", sourceId).put("accountId", targetId).put("rows", JSONArray().put(selection))
                        val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/providers/simplefin/$linkId/import", body) }
                        rows.find { it.optString("externalId") == rowId }?.put("status", "imported")
                        rowId = ""; note = "${result.optInt("imported")} imported; ${result.optInt("duplicates")} already imported. ${result.optString("note")}"; onChanged(); refresh()
                    } }) { Text("Confirm this transaction import") }
                }
            }
        }
        TextButton(onClick = { preview = null; rowId = "" }) { Text("Close preview") }
    }
    if (note.isNotBlank()) Text(note)
}

@Composable
internal fun ConnectedInvestments(api: BudgetApi, hid: String, positions: JSONArray, privacy: Boolean, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    val holdings = positions.objects()
    var holdingId by rememberSaveable(hid) { mutableStateOf("") }
    var lots by remember(hid) { mutableStateOf(JSONObject()) }
    var quote by remember(hid) { mutableStateOf<JSONObject?>(null) }
    var preview by rememberSaveable(hid) { mutableStateOf("") }
    var body by rememberSaveable(hid) { mutableStateOf("") }
    var quantity by rememberSaveable(hid) { mutableStateOf("") }
    var proceeds by rememberSaveable(hid) { mutableStateOf("") }
    var soldOn by rememberSaveable(hid) { mutableStateOf(java.time.LocalDate.now().toString()) }
    var busy by remember { mutableStateOf(false) }
    var note by remember(hid) { mutableStateOf("") }
    var basisId by remember(hid) { mutableStateOf("") }
    var basis by rememberSaveable(hid) { mutableStateOf("") }
    var basisRevision by remember(hid) { mutableLongStateOf(0) }
    var newShares by rememberSaveable(hid) { mutableStateOf("") }
    var newBasis by rememberSaveable(hid) { mutableStateOf("") }
    var acquired by rememberSaveable(hid) { mutableStateOf(java.time.LocalDate.now().toString()) }
    var addRequest by rememberSaveable(hid) { mutableStateOf("") }
    suspend fun refresh() { lots = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/lots") } }
    fun act(work: suspend () -> Unit) { if (busy) return; busy = true; scope.launch { try { work() } catch (c: CancellationException) { throw c } catch (e: Exception) { note = e.message ?: "The investment action failed." } finally { busy = false } } }
    LaunchedEffect(hid) { try { refresh() } catch (e: Exception) { note = e.message ?: "Could not load lots." } }
    Text("Prices and lot sales", style = MaterialTheme.typography.titleLarge)
    FinancePick("Holding", holdings, holdingId, "holdingId", "symbol") { holdingId = it; quote = null; preview = ""; body = ""; basisId = ""; addRequest = "" }
    val holding = holdings.find { it.optString("holdingId") == holdingId }
    if (holding != null && holding.optString("currency") == "USD") {
        Button(enabled = !busy, onClick = { act { quote = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/holdings/$holdingId/quote/preview", JSONObject()) } } }) { Text("Preview Finnhub price") }
        quote?.let { result ->
            val value = result.optJSONObject("quote") ?: result
            Text("${money(value.optLong("priceMinor"), privacy)} · ${value.optString("asOf")} · Finnhub. Confirming updates investment value, not cash.")
            Button(enabled = !busy, onClick = { act {
                withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/holdings/$holdingId/quote/confirm", JSONObject().put("previewId", result.getString("previewId"))) }
                quote = null; note = "Price saved. Cash was unchanged."; onChanged()
            } }) { Text("Confirm market price") }
            TextButton(onClick = { quote = null }) { Text("Cancel price preview") }
        }
        Text("Add a lot for shares already in this holding", style = MaterialTheme.typography.titleMedium)
        FinanceField("Lot shares", newShares) { newShares = it; addRequest = "" }
        FinanceField("Lot cost basis, blank means unknown", newBasis) { newBasis = it; addRequest = "" }
        FinanceField("Acquired YYYY-MM-DD", acquired) { acquired = it; addRequest = "" }
        Button(enabled = !busy && newShares.isNotBlank(), onClick = { act {
            if (addRequest.isBlank()) addRequest = JSONObject().put("holdingId", holdingId).put("quantityMicro", microShares(newShares)).put("costBasisMinor", if (newBasis.isBlank()) JSONObject.NULL else parseDollars(newBasis)).put("acquired", acquired).put("opId", UUID.randomUUID().toString()).toString()
            withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/lots", JSONObject(addRequest)) }
            addRequest = ""; newShares = ""; newBasis = ""; preview = ""; body = ""; refresh(); note = "Lot recorded. It did not add shares or change cash."; onChanged()
        } }) { Text("Save lot") }
        (lots.optJSONArray("lots") ?: JSONArray()).objects().filter { it.optString("holdingId") == holdingId }.forEach { lot ->
            Text("${lot.optString("acquired")} · ${lot.optLong("quantityMicro") / 1000000.0} shares · basis ${if (lot.isNull("costBasisMinor")) "missing" else money(lot.optLong("costBasisMinor"), privacy)}")
            TextButton(enabled = !busy, onClick = { basisId = lot.getString("id"); basis = if (lot.isNull("costBasisMinor")) "" else amountField(lot.getLong("costBasisMinor")); basisRevision = lot.getLong("revision") }) { Text("Edit this lot’s basis") }
        }
        if (basisId.isNotBlank()) {
            FinanceField("Remaining basis, blank means unknown", basis) { basis = it }
            Button(enabled = !busy, onClick = { act {
                withContext(Dispatchers.IO) { api.request("PATCH", "/api/households/$hid/lots/$basisId", JSONObject().put("expectedRevision", basisRevision).put("costBasisMinor", if (basis.isBlank()) JSONObject.NULL else parseDollars(basis))) }
                basisId = ""; preview = ""; body = ""; refresh(); onChanged()
            } }) { Text("Save basis") }
            TextButton(onClick = { basisId = "" }) { Text("Cancel basis edit") }
        }
        FinanceField("Shares sold", quantity) { quantity = it; preview = ""; body = "" }
        FinanceField("Net proceeds after fees", proceeds) { proceeds = it; preview = ""; body = "" }
        FinanceField("Sale date YYYY-MM-DD", soldOn) { soldOn = it; preview = ""; body = "" }
        Text("A recorded sale reduces this holding and keeps its realized-gain history. Record the proceeds once in your cash register separately.")
        Button(enabled = !busy && quantity.isNotBlank() && proceeds.isNotBlank(), onClick = { act {
            if (preview.isBlank()) {
                if (body.isBlank()) body = JSONObject().put("holdingId", holdingId).put("quantityMicro", microShares(quantity)).put("proceedsMinor", parseDollars(proceeds)).put("soldOn", soldOn).put("expectedRevision", lots.getJSONObject("revisions").getLong(holdingId)).put("opId", UUID.randomUUID().toString()).toString()
                preview = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/lots/preview", JSONObject(body)) }.toString()
            } else {
                val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/lots/sell", JSONObject(body)) }
                note = result.optString("note"); preview = ""; body = ""; quantity = ""; proceeds = ""; refresh(); onChanged()
            }
        } }) { Text(if (preview.isBlank()) "Preview FIFO sale" else "Confirm lot sale") }
        if (preview.isNotBlank()) {
            val result = JSONObject(preview)
            Text("FIFO basis ${money(result.optLong("basisMinor"), privacy)} · gain ${money(result.optLong("gainMinor"), privacy)}. Preview has not changed your accounts.")
            TextButton(onClick = { preview = ""; body = "" }) { Text("Cancel sale preview") }
        }
    } else if (holding != null) Text("Use the web lot controls for this currency. Android connected investment controls currently support USD.")
    TextButton(enabled = !busy, onClick = { act { refresh(); preview = ""; body = ""; basisId = ""; note = "Loaded latest lots. A new sale preview is required." } }) { Text("Reload lots and discard preview") }
    Text("Saved sales", style = MaterialTheme.typography.titleMedium)
    (lots.optJSONArray("sales") ?: JSONArray()).objects().forEach { sale -> Text("${sale.optString("soldOn")} · ${sale.optString("symbol")} · realized gain ${if (privacy) "••••" else "${amountField(sale.optLong("gainMinor"))} ${sale.optString("currency")}"}") }
    if (note.isNotBlank()) Text(note)
}

@Composable
internal fun MonthlyRetirementScreen(api: BudgetApi, hid: String, privacy: Boolean) {
    val scope = rememberCoroutineScope()
    var values by rememberSaveable(hid) { mutableStateOf("{\"portfolio\":\"100000\",\"traditional\":\"70000\",\"spending\":\"12000\",\"contribution\":\"0\",\"return\":\"4\",\"tax\":\"22\",\"age\":\"73\",\"birth\":\"1953\",\"months\":\"12\",\"prior\":\"\"}") }
    var strategy by rememberSaveable(hid) { mutableStateOf("other_first") }
    var result by remember(hid) { mutableStateOf<JSONObject?>(null) }
    var error by remember(hid) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var showMonths by remember { mutableStateOf(false) }
    Text("Monthly withdrawal comparison", style = MaterialTheme.typography.titleLarge)
    Text("Starts January 1. This is a simplified flat-tax comparison, without inflation, tax brackets, early withdrawal penalties or contribution limits. Inherited accounts and a sole-beneficiary spouse more than ten years younger are not supported. It does not change your accounts.")
    val fields = listOf("portfolio" to "Total portfolio", "traditional" to "Traditional portion", "prior" to "Prior December 31 traditional balance, optional", "spending" to "Annual spending after tax", "contribution" to "Annual traditional contributions", "return" to "Assumed annual return percent", "tax" to "Tax percent on traditional withdrawals", "age" to "Age at December 31 of starting year", "birth" to "Birth year", "months" to "Months, up to 600")
    fields.forEach { (key, label) -> FinanceField(label, JSONObject(values).optString(key)) { values = JSONObject(values).put(key, it).toString(); result = null } }
    TextButton(onClick = { strategy = if (strategy == "other_first") "traditional_first" else "other_first"; result = null }) { Text(if (strategy == "other_first") "Monthly details: other funds first" else "Monthly details: traditional first") }
    Button(enabled = !busy, onClick = {
        busy = true; error = ""
        scope.launch { try {
            val v = JSONObject(values)
            val body = JSONObject().put("portfolioMinor", parseDollars(v.getString("portfolio"))).put("traditionalMinor", parseDollars(v.getString("traditional"))).put("annualSpendingMinor", parseDollars(v.getString("spending"))).put("annualContributionMinor", parseDollars(v.getString("contribution"))).put("annualReturnBps", BigDecimal(v.getString("return")).movePointRight(2).intValueExact()).put("taxBps", BigDecimal(v.getString("tax")).movePointRight(2).intValueExact()).put("age", v.getString("age").toInt()).put("birthYear", v.getString("birth").toInt()).put("months", v.getString("months").toInt()).put("strategy", strategy)
            if (v.getString("prior").isNotBlank()) body.put("priorYearTraditionalMinor", parseDollars(v.getString("prior")))
            result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/retirement/monthly", body) }
        } catch (c: CancellationException) { throw c } catch (e: Exception) { error = e.message ?: "The comparison could not run." } finally { busy = false } }
    }) { Text("Compare withdrawal orders") }
    if (error.isNotBlank()) Text(error)
    result?.let { data ->
        (data.optJSONArray("comparison") ?: JSONArray()).objects().forEach { row -> Text("${if (row.optString("strategy") == "other_first") "Other funds first" else "Traditional first"}: ending ${money(row.optLong("endingMinor"), privacy)}, tax ${money(row.optLong("taxMinor"), privacy)}, unfunded spending ${money(row.optLong("unmetSpendingMinor"), privacy)}") }
        TextButton(onClick = { showMonths = !showMonths }) { Text(if (showMonths) "Hide monthly amounts" else "Show monthly amounts") }
        if (showMonths) (data.optJSONArray("months") ?: JSONArray()).objects().forEach { row -> Text("Month ${row.optInt("month")}: portfolio ${money(row.optLong("portfolioMinor"), privacy)}, traditional withdrawal ${money(row.optLong("withdrawalMinor"), privacy)}, required distribution ${money(row.optLong("rmdMinor"), privacy)}, tax ${money(row.optLong("taxMinor"), privacy)}, unfunded spending ${money(row.optLong("unmetSpendingMinor"), privacy)}, RMD shortfall ${money(row.optLong("unmetRmdMinor"), privacy)}") }
        val assumptions = data.optJSONArray("assumptions") ?: JSONArray()
        for (i in 0 until assumptions.length()) Text(assumptions.optString(i))
    }
}
