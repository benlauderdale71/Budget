package com.budgetcents.app.ui

import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.budgetcents.app.BudgetApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.LocalDate

@Composable
internal fun StatementPdf(api: BudgetApi, hid: String, accountId: String, onDraft: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var year by remember { mutableStateOf(LocalDate.now().year.toString()) }
    var status by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            busy = true
            try {
                val result = withContext(Dispatchers.IO) {
                    val output = ByteArrayOutputStream()
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        val buffer = ByteArray(16_384)
                        while (true) {
                            val count = stream.read(buffer)
                            if (count < 0) break
                            require(output.size() + count <= 8_000_000) { "Choose a PDF up to 8 MB." }
                            output.write(buffer, 0, count)
                        }
                    } ?: error("Could not open PDF.")
                    val body = JSONObject().put("accountId", accountId).put("year", year.toInt())
                        .put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                    api.request("POST", "/api/households/$hid/import/statement-pdf", body)
                }
                val rows = result.getJSONArray("rows")
                val lines = mutableListOf("Date,Payee,Amount,Notes")
                var uncertain = 0
                for (i in 0 until rows.length()) {
                    val row = rows.getJSONObject(i)
                    if (row.optString("issue").isNotEmpty()) uncertain++
                    val note = "Page "+row.optInt("page")+" · "+row.optString("source")+" "+row.optString("issue")
                    lines += listOf(row.optString("date"),row.optString("payee"),row.optString("amount"),note)
                        .joinToString(",") { "\"" + it.replace("\"","\"\"") + "\"" }
                }
                onDraft(lines.joinToString("\n"))
                val warnings = result.getJSONArray("warnings")
                status = "Read "+rows.length()+" rows. "+uncertain+" need attention. Edit the draft below, remove unwanted lines and add missing entries. Use negative amounts for money out. "+
                    (0 until warnings.length()).joinToString(" ") { warnings.getString(it) }
            } catch (e: Exception) { status=e.message.orEmpty() } finally { busy=false }
        }
    }
    OutlinedTextField(year, {year=it}, label={Text("Year for dates without a printed year")}, modifier=Modifier.fillMaxWidth())
    Button(enabled=!busy && accountId.isNotBlank() && year.toIntOrNull() in 1900..2200,
        onClick={picker.launch(arrayOf("application/pdf"))}) { Text(if(busy) "Reading PDF…" else "Read bank statement PDF") }
    if(status.isNotBlank()) Text(status)
}
