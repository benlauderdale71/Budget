package com.budgetcents.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.budgetcents.app.ApiException
import com.budgetcents.app.BudgetApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

@Composable
internal fun IncomePlanScreen(api: BudgetApi, hid: String, dash: JSONObject?, privacy: Boolean, onChanged: () -> Unit) {
    val space = dash?.optString("spaceId") ?: ""
    var snapshot by rememberSaveable(hid, space) { mutableStateOf("") }
    var amounts by rememberSaveable(hid, space) { mutableStateOf("{}") }
    var dirty by rememberSaveable(hid, space) { mutableStateOf(false) }
    var requestBody by rememberSaveable(hid, space) { mutableStateOf("") }
    var opId by rememberSaveable(hid, space) { mutableStateOf("") }
    var newest by remember(hid, space) { mutableStateOf<JSONObject?>(null) }
    var error by remember(hid, space) { mutableStateOf("") }
    var busy by remember(hid, space) { mutableStateOf(false) }
    var reload by remember(hid, space) { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    fun adopt(data: JSONObject) {
        snapshot = data.toString()
        val values = JSONObject()
        val lines = data.optJSONArray("lines") ?: JSONArray()
        for (i in 0 until lines.length()) {
            val line = lines.getJSONObject(i)
            values.put(line.getString("bucketId"), amountField(line.getLong("plannedMinor")))
        }
        amounts = values.toString()
        dirty = false
        requestBody = ""
        opId = ""
        error = ""
    }
    LaunchedEffect(hid, space, reload, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                try {
                    val latest = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/income-plan?spaceId=$space") }
                    newest = latest
                    if (!dirty || snapshot.isBlank()) adopt(latest)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (caught: Exception) {
                    error = caught.message ?: "Could not refresh the income plan. Your draft is still here."
                    if (caught is ApiException && caught.status in listOf(401, 403, 404)) {
                        snapshot = ""; amounts = "{}"; dirty = false; newest = null
                    }
                }
                delay(12000)
            }
        }
    }
    if (snapshot.isBlank()) {
        Text(error.ifBlank { "Loading income plan…" })
        TextButton(onClick = { reload++ }) { Text("Retry") }
        return
    }
    val base = JSONObject(snapshot)
    val stale = newest?.optLong("revision")?.let { it != base.optLong("revision") } == true
    Text(base.optString("note"))
    Text("Expected ${money(base.optLong("expectedIncomeMinor"), privacy)} · Planned ${money(base.optLong("plannedMinor"), privacy)}")
    if (stale) Text("A newer income plan is saved. Your draft is still here. Discard it to load the latest plan.")
    val buckets = dash?.optJSONArray("buckets") ?: JSONArray()
    val active = (0 until buckets.length()).map { buckets.getJSONObject(it) }.filter {
        it.optString("kind") == "expense" && !it.optBoolean("archived") && (it.isNull("systemRole") || it.optString("systemRole").isBlank())
    }
    active.forEach { bucket ->
        val bucketId = bucket.getString("id")
        OutlinedTextField(
            value = JSONObject(amounts).optString(bucketId, "0.00"),
            onValueChange = { amounts = JSONObject(amounts).put(bucketId, it).toString(); dirty = true },
            label = { Text(bucket.optString("name")) }, modifier = Modifier.fillMaxWidth(), enabled = !busy,
        )
    }
    if (error.isNotBlank()) Text(error)
    Button(enabled = !busy && !stale, onClick = {
        busy = true
        scope.launch {
            try {
                val lines = JSONArray()
                active.forEach { bucket ->
                    val bucketId = bucket.getString("id")
                    val value = parseDollars(JSONObject(amounts).optString(bucketId, "0"))
                    require(value >= 0) { "Planned amounts must be zero or positive." }
                    lines.put(JSONObject().put("bucketId", bucketId).put("plannedMinor", value))
                }
                val body = JSONObject().put("spaceId", base.getString("spaceId")).put("periodKey", base.getString("periodKey"))
                    .put("expectedRevision", base.getLong("revision")).put("lines", lines)
                if (requestBody != body.toString()) { requestBody = body.toString(); opId = UUID.randomUUID().toString() }
                val saved = withContext(Dispatchers.IO) { api.request("PUT", "/api/households/$hid/income-plan", body.put("opId", opId)) }
                snapshot = base.put("revision", saved.getLong("revision")).put("lines", lines).toString()
                dirty = false
                error = ""
                reload++
                onChanged()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (caught: Exception) { error = caught.message ?: "The income plan was not saved." }
            finally { busy = false }
        }
    }) { Text(if (busy) "Saving…" else "Save income plan") }
    if (dirty || stale || error.isNotBlank()) TextButton(enabled = !busy, onClick = {
        // Preserve the draft if a newer authorized snapshot could not be loaded.
        newest?.let { adopt(it) }
        reload++
    }) { Text("Discard draft and load latest income plan") }
}
