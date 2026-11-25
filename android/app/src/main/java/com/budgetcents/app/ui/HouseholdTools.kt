package com.budgetcents.app.ui

import android.net.Uri
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.budgetcents.app.BudgetApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.text.NumberFormat
import java.time.LocalDate
import java.util.Currency

private fun JSONObject.rows(name: String): List<JSONObject> {
    val values = optJSONArray(name) ?: return emptyList()
    return (0 until values.length()).map { values.getJSONObject(it) }
}

private class ToolApi(val api: BudgetApi, val hid: String, val space: String) {
    suspend fun call(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val separator = if (path.contains('?')) "&" else "?"
        val url = "/api/households/$hid/$path" + separator + "spaceId=" + Uri.encode(space)
        api.request(if (body == null) "GET" else "POST", url, body)
    }
}

private class ToolCurrency(code: String, val hidden: Boolean) {
    private val unit = Currency.getInstance(code)
    fun display(minor: Long): String {
        if (hidden) return "••••"
        return NumberFormat.getCurrencyInstance().apply { currency = unit; minimumFractionDigits = unit.defaultFractionDigits; maximumFractionDigits = unit.defaultFractionDigits }
            .format(BigDecimal.valueOf(minor, unit.defaultFractionDigits))
    }
    fun input(minor: Long) = BigDecimal.valueOf(minor, unit.defaultFractionDigits).toPlainString()
    fun parse(value: String) = BigDecimal(value.trim()).movePointRight(unit.defaultFractionDigits).longValueExact()
}

@Composable
private fun ToolField(label: String, value: String, change: (String) -> Unit) {
    OutlinedTextField(value, change, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth())
}

@Composable
internal fun HouseholdTool(page: String, api: BudgetApi, hid: String, dash: JSONObject?, privacy: Boolean) {
    if (dash == null) { Text("Loading accounts…"); return }
    val space = dash.optString("spaceId")
    val client = remember(api, hid, space) { ToolApi(api, hid, space) }
    val home = dash.optJSONObject("household")
    val writable = home?.optString("role") in listOf("owner", "admin", "editor", "contributor")
    val currency = home?.optString("currency", "USD") ?: "USD"
    val accounts = dash.rows("accounts").filter { page != "Catch-up plan" ||
        (it.optBoolean("onBudget") && !it.optBoolean("archived") && it.optString("currency") == currency && it.optString("kind") in listOf("checking","cash","savings")) }
    if (accounts.isEmpty()) { Text("No eligible accounts in this space."); return }
    var choice by remember(page, client) { mutableStateOf(accounts.first().getString("id")) }
    val account = accounts.find { it.optString("id") == choice } ?: accounts.first()
    Text("Account")
    accounts.forEach { a -> TextButton(onClick = { choice = a.getString("id") }) { Text((if (a == account) "✓ " else "") + a.optString("name")) } }
    val id = account.getString("id")
    val unit = ToolCurrency(account.optString("currency",currency), privacy)
    key(page, client, id, privacy) {
        when (page) {
            "Statement coverage" -> MobileStatements(client, id, unit, writable)
            "Catch-up plan" -> if (privacy) Text("Show amounts to open your plan.") else MobileCatchUp(client, id, unit, writable)
            "Merchant corrections" -> if (writable) MobileCorrections(client, id, dash.rows("buckets"), unit) else Text("Editing access is required for merchant corrections.")
        }
    }
}

@Composable
private fun MobileStatements(client: ToolApi, id: String, unit: ToolCurrency, writable: Boolean) {
    var year by remember { mutableStateOf(LocalDate.now().year) }
    var reload by remember { mutableIntStateOf(0) }
    var account by remember(year) { mutableStateOf<JSONObject?>(null) }
    var report by remember(year) { mutableStateOf<JSONObject?>(null) }
    var start by remember { mutableStateOf("") }; var end by remember { mutableStateOf("") }; var closing by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }; var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val query = "?year=$year&accountId=" + Uri.encode(id)
    LaunchedEffect(year, reload) {
        try {
            account = client.call("statement-coverage$query").rows("accounts").firstOrNull()
            report = client.call("reports/spending-year$query")
        } catch (e: Exception) { message = e.message.orEmpty() }
    }
    TextButton({year--}) { Text("Previous year") }; Text(year.toString()); TextButton({year++}) { Text("Next year") }
    report?.let { r ->
        val row = r.getJSONObject("summary")
        val reportUnit = ToolCurrency(r.getString("currency"), unit.hidden)
        Text("Year total ÷ 12: " + reportUnit.display(row.getLong("monthlyAverageMinor")))
        Text("Average per complete month: " + if (row.isNull("completeMonthAverageMinor")) "Unavailable" else reportUnit.display(row.getLong("completeMonthAverageMinor")))
        Text((r.optJSONArray("completeMonths")?.length() ?: 0).toString() + " of 12 months reconciled")
    }
    account?.let { a ->
        a.rows("months").forEach { m -> Text(m.optString("month") + " · " + m.optString("status") + " · " + m.optInt("imported") + " imported") }
        a.rows("statements").forEach { p -> Text(p.optString("start")+" – "+p.optString("end")+" · closing "+unit.display(p.getLong("closingMinor"))+" · difference "+unit.display(p.getLong("differenceMinor"))) }
        if (writable && !unit.hidden) {
            ToolField("Statement starts (YYYY-MM-DD)",start) { start=it }; ToolField("Statement ends (YYYY-MM-DD)",end) { end=it }
            ToolField("Closing balance",closing) { closing=it }
            Button(enabled=!saving,onClick={
                saving=true
                scope.launch {
                    try {
                        val old=a.rows("statements").find { it.optString("end")==end }
                        val previous=old?.let { JSONObject().put("start",it.optString("start")).put("closingMinor",it.getLong("closingMinor")) }
                        client.call("statement-coverage",JSONObject().put("accountId",id).put("start",start).put("end",end).put("closingMinor",unit.parse(closing)).put("previous",previous?:JSONObject.NULL))
                        year=LocalDate.parse(end).year; reload++; message="Statement saved."
                    } catch(e:Exception) { message=e.message.orEmpty() } finally { saving=false }
                }
            }) { Text("Save statement") }
        }
    }
    Text(message)
}

@Composable
private fun MobileCatchUp(client: ToolApi, id: String, unit: ToolCurrency, writable: Boolean) {
    var saved by remember { mutableStateOf<JSONObject?>(null) }; var loadError by remember { mutableStateOf("") }
    LaunchedEffect(client,id) { try { saved=client.call("catch-up?accountId="+Uri.encode(id)) } catch(e:Exception){loadError=e.message.orEmpty()} }
    if (saved==null) { Text(loadError.ifBlank { "Loading plan…" }); return }
    val terms=saved?.optJSONObject("terms")
    var version by remember { mutableIntStateOf(saved!!.optInt("version")) }
    var name by remember { mutableStateOf(terms?.optString("name")?:"") }
    var start by remember { mutableStateOf(terms?.optString("asOf")?:LocalDate.now().toString()) }
    var days by remember { mutableStateOf(terms?.optInt("days")?.toString()?:"90") }
    var debt by remember { mutableStateOf(terms?.let { unit.input(it.getLong("pastDueMinor")) }?:"") }
    var buffer by remember { mutableStateOf(unit.input(terms?.optLong("bufferMinor")?:0L)) }
    var essentials by remember { mutableStateOf(unit.input(terms?.optLong("essentialsPerPayMinor")?:0L)) }
    val regular=terms?.optJSONObject("regular")
    var due by remember { mutableStateOf(regular?.optString("date")?:"") }
    var normal by remember { mutableStateOf(regular?.let { unit.input(it.getLong("amountMinor")) }?:"") }
    val installments=remember { mutableStateListOf<Pair<String,String>>().apply {
        addAll(terms?.rows("agreements")?.map { it.optString("date") to unit.input(it.optLong("amountMinor")) }?:emptyList())
    } }
    val fingerprint=listOf(name,start,days,debt,buffer,essentials,due,normal,installments.toList())
    var result by remember(fingerprint) { mutableStateOf<JSONObject?>(null) }
    var status by remember(fingerprint) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }; val scope=rememberCoroutineScope()
    ToolField("Bill or creditor",name){name=it}; ToolField("Past-due balance",debt){debt=it}
    ToolField("Start date (YYYY-MM-DD)",start){start=it}; ToolField("Forecast days (1–366)",days){days=it}
    ToolField("Essentials per payday",essentials){essentials=it}; ToolField("Cash buffer",buffer){buffer=it}
    Text("Scheduled bills are included. Enter a regular payment only if it is missing from the schedule.")
    ToolField("Optional regular payment",normal){normal=it}; ToolField("Regular payment date",due){due=it}
    installments.forEachIndexed { index, payment ->
        ToolField("Agreed installment date",payment.first){installments[index]=it to payment.second}
        ToolField("Agreed amount",payment.second){installments[index]=payment.first to it}
        TextButton({installments.removeAt(index)}){Text("Remove installment")}
    }
    TextButton({installments.add("" to "")}){Text("Add agreed installment")}
    fun calculate(save:Boolean) {
        busy=true
        scope.launch {
            try {
                fun payment(date:String,value:String)=JSONObject().put("date",date).put("amountMinor",unit.parse(value))
                val plan=JSONObject().put("name",name).put("asOf",start).put("days",days.toInt()).put("pastDueMinor",unit.parse(debt))
                    .put("bufferMinor",unit.parse(buffer)).put("essentialsPerPayMinor",unit.parse(essentials))
                    .put("regular",if(normal.isBlank() && due.isBlank()) JSONObject.NULL else payment(due,normal))
                    .put("agreements",JSONArray().apply { installments.forEach { put(payment(it.first,it.second)) } })
                val response=client.call("catch-up",JSONObject().put("accountId",id).put("terms",plan).put("version",version).put("save",save))
                result=response; version=response.getInt("version"); status=if(save) "Plan saved." else ""
            } catch(e:Exception){result=null;status=e.message.orEmpty()} finally{busy=false}
        }
    }
    Button(enabled=!busy,onClick={calculate(false)}){Text("Calculate plan")}
    if(writable) TextButton(enabled=!busy,onClick={calculate(true)}){Text("Save and calculate")}
    Text(status)
    result?.let { r ->
        Text("Lowest balance: "+unit.display(r.getLong("lowestMinor"))+" on "+r.optString("lowestDate"))
        Text(if(r.isNull("payoffDate")) "No funded payoff date in this forecast." else "Projected catch-up: "+r.getString("payoffDate"))
        if(!r.isNull("firstShortfall")) Text("Shortfall on "+r.getString("firstShortfall"))
        Text("Remaining after planned payments: "+unit.display(r.getLong("remainingMinor")))
        r.rows("rows").forEach { row ->
            Text(row.getString("date")+" · pay "+unit.display(row.getLong("payMinor"))+" · bills "+unit.display(row.getLong("billsMinor"))+" · essentials "+unit.display(row.getLong("essentialsMinor"))+
                " · agreed "+unit.display(row.getLong("agreedMinor"))+" · extra "+unit.display(row.getLong("extraMinor"))+" · balance "+unit.display(row.getLong("balanceMinor")))
        }
    }
}


@Composable
private fun MobileCorrections(client:ToolApi, id:String, buckets:List<JSONObject>, unit:ToolCurrency) {
    var search by remember { mutableStateOf("") }; var query by remember { mutableStateOf("") }
    var reload by remember { mutableIntStateOf(0) }; var offset by remember { mutableIntStateOf(0) }
    var source by remember(query,offset) { mutableStateOf<JSONObject?>(null) }
    var category by remember(source) { mutableStateOf("") }; var future by remember { mutableStateOf(true) }
    var preview by remember(source,category,future) { mutableStateOf<JSONObject?>(null) }
    var page by remember(query,offset,reload) { mutableStateOf<JSONObject?>(null) }
    var history by remember { mutableStateOf(emptyList<JSONObject>()) }
    var message by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val scope=rememberCoroutineScope()
    fun name(bucket:String)=buckets.find { it.optString("id")==bucket }?.optString("name")?:"Uncategorized"
    LaunchedEffect(query,offset,reload) {
        try {
            page=client.call("transactions?accountId="+Uri.encode(id)+"&q="+Uri.encode(query)+"&limit=20&offset="+offset)
            history=client.call("merchant-corrections").rows("batches").filter { it.optString("account_id")==id }
        } catch(e:Exception){message=e.message.orEmpty()}
    }
    ToolField("Find a merchant",search){search=it}
    Button({query=search;offset=0;source=null}){Text("Search")}
    page?.rows("transactions")?.filter { !it.optBoolean("reconciled") && !it.optBoolean("locked") && it.optString("bankStatus")=="posted" && it.optString("type") in listOf("expense","fee","income") && it.rows("splits").size<=1 }?.forEach { txn ->
        TextButton({source=txn}){Text(txn.optString("date")+" · "+txn.optString("payee")+" · "+unit.display(txn.optLong("amountMinor")))}
    }
    if(offset>0) TextButton({offset=(offset-20).coerceAtLeast(0)}){Text("Previous page")}
    page?.let { if(!it.isNull("nextOffset")) TextButton({offset=it.getInt("nextOffset")}){Text("Next page")} }
    source?.let { txn ->
        Text("Choose a category for "+txn.getString("payee"))
        val kind=if(txn.getLong("amountMinor")<0) "expense" else "income"
        buckets.filter { it.optString("kind")==kind && it.isNull("systemRole") && !it.optBoolean("archived") && !it.optBoolean("hidden") }.forEach { b ->
            TextButton({category=b.getString("id")}){Text((if(category==b.optString("id")) "✓ " else "")+b.optString("name"))}
        }
        Text("Apply to future matching imports"); Checkbox(future,{future=it})
        fun correct(confirm:String?) {
            busy=true
            scope.launch {
                try {
                    val body=JSONObject().put("sourceId",txn.getString("id")).put("bucketId",category).put("future",future)
                    if(confirm!=null) body.put("confirm",confirm)
                    val response=client.call("merchant-corrections",body)
                    if(confirm==null) preview=response else {preview=null;message="Correction applied.";reload++}
                } catch(e:Exception){preview=null;message=e.message.orEmpty()} finally{busy=false}
            }
        }
        Button(enabled=category.isNotBlank() && !busy,onClick={correct(null)}){Text("Preview matches")}
        preview?.let { p ->
            Text(p.rows("rows").size.toString()+" existing matches · new category "+name(category))
            p.rows("rows").forEach { row -> Text(row.optString("date")+" · "+row.optString("payee")+" · "+unit.display(row.optLong("amountMinor"))+" · "+name(row.optString("priorBucket"))) }
            Button(enabled=!busy && (future || p.rows("rows").isNotEmpty()),onClick={correct(p.getString("token"))}){Text("Apply correction")}
        }
    }
    Text(message)
    Text("Active corrections")
    history.forEach { b ->
        Text(b.optString("merchant_key").split("|").drop(1).joinToString(" · ")+" → "+name(b.optString("bucket_id"))+" · "+b.optInt("count")+" transactions")
        TextButton(enabled=!busy,onClick={
            busy=true;scope.launch {
                try { val r=client.call("merchant-corrections/"+Uri.encode(b.optString("id"))+"/undo",JSONObject())
                    message="Restored "+r.optInt("restored")+" transactions. Preserved "+r.optInt("skipped")+" later changes."; reload++; preview=null
                } catch(e:Exception){message=e.message.orEmpty()} finally {busy=false}
            }
        }){Text("Undo this batch")}
    }
}

@Composable
internal fun HouseholdAnnualSpending(api:BudgetApi, hid:String, space:String, privacy:Boolean) {
    val client=remember(api,hid,space){ToolApi(api,hid,space)}
    var year by remember { mutableIntStateOf(LocalDate.now().year) }
    var result by remember(client,year) { mutableStateOf<JSONObject?>(null) }
    var error by remember(client,year) { mutableStateOf("") }
    LaunchedEffect(client,year) {
        try { result=client.call("reports/spending-year?year=$year") } catch(e:Exception){error=e.message.orEmpty()}
    }
    Text("Household spending · $year")
    TextButton({year--}){Text("Previous year")}; TextButton({year++}){Text("Next year")}
    result?.let { report ->
        val unit=ToolCurrency(report.getString("currency"),privacy)
        val summary=report.getJSONObject("summary")
        Text("Recorded spending: "+unit.display(summary.getLong("yearlyMinor")))
        Text("Year total ÷ 12: "+unit.display(summary.getLong("monthlyAverageMinor")))
        val months=report.optJSONArray("completeMonths")?:JSONArray()
        Text("Average across "+months.length()+" reconciled months: "+if(summary.isNull("completeMonthAverageMinor")) "Unavailable" else unit.display(summary.getLong("completeMonthAverageMinor")))
    }
    if(error.isNotEmpty()) Text(error)
}
