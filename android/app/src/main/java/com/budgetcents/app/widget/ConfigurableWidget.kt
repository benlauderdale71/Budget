package com.budgetcents.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContracts
import android.widget.RemoteViews
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.hasText
import com.budgetcents.app.MainActivity
import com.budgetcents.app.R
import com.budgetcents.app.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private val WIDGET_KINDS = listOf(
    "category" to "Category or envelope",
    "flex" to "Flexible spending",
    "bill" to "Upcoming bill",
    "goal" to "Goal",
    "quick" to "Quick add",
)

class ConfigurableWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { id -> updateConfigurable(context, manager, id) }
    }
}

private fun recordText(map: JSONObject?, recordId: String, fallback: String): String {
    if (map == null) return fallback
    if (recordId.isBlank()) {
        val keys = map.keys()
        return if (keys.hasNext()) map.optString(keys.next(), fallback) else fallback
    }
    return if (map.has(recordId)) map.optString(recordId) else "That record is no longer available"
}

fun updateConfigurable(context: Context, manager: AppWidgetManager, id: Int) {
    val store = Store(context)
    val kind = store.widgetKind(id)
    val recordId = store.widgetRecord(id)
    val facts = store.widgetFacts
    val parsed = if (facts.isBlank()) JSONObject() else runCatching { JSONObject(facts) }.getOrDefault(JSONObject())
    val title = WIDGET_KINDS.firstOrNull { it.first == kind }?.second ?: "BudgetCents"
    val fresh = parsed.optBoolean("fresh", true)
    val household = parsed.optString("householdId")
    val body = when {
        store.token.isNullOrBlank() -> "Sign in to BudgetCents"
        store.biometric || (store.privacy && kind != "quick") -> if (kind == "quick") "Add a transaction" else "Unlock BudgetCents"
        household.isNotBlank() && household != store.householdId -> "Open BudgetCents to refresh this household"
        else -> {
            val text = when (kind) {
                "flex" -> parsed.optString("flex", "Flexible spending")
                "quick" -> "Add a transaction"
                "category" -> recordText(parsed.optJSONObject("categories"), recordId, "Choose a category")
                "bill" -> recordText(parsed.optJSONObject("bills"), recordId, "No upcoming bill")
                "goal" -> recordText(parsed.optJSONObject("goals"), recordId, "No goal yet")
                else -> context.getString(R.string.widget_empty)
            }
            if (fresh) text else "$text · Saved on this device"
        }
    }
    val views = RemoteViews(context.packageName, R.layout.widget_configured)
    views.setTextViewText(R.id.widget_title, title)
    views.setTextViewText(R.id.widget_body, body)
    val link = when (kind) {
        "quick" -> "budgetcents://activity"
        "bill" -> if (recordId.isBlank()) "budgetcents://bills" else "budgetcents://bill/$recordId"
        "goal" -> if (recordId.isBlank()) "budgetcents://goals" else "budgetcents://goal/$recordId"
        "category" -> if (recordId.isBlank()) "budgetcents://categories" else "budgetcents://categories/$recordId"
        else -> "budgetcents://plan"
    }
    val pending = PendingIntent.getActivity(
        context,
        id,
        Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    views.setOnClickPendingIntent(R.id.widget_root, pending)
    manager.updateAppWidget(id, views)
}

fun refreshConfigurableWidgets(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val ids = manager.getAppWidgetIds(android.content.ComponentName(context, ConfigurableWidget::class.java))
    ids.forEach { id -> updateConfigurable(context, manager, id) }
}

class WidgetConfigureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val widgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        setResult(RESULT_CANCELED)
        setContent {
            val scope = rememberCoroutineScope()
            var kind by remember { mutableStateOf("category") }
            var recordId by remember { mutableStateOf("") }
            var dash by remember { mutableStateOf<JSONObject?>(null) }
            var status by remember { mutableStateOf("Choose what this widget shows. Amounts stay hidden while privacy or the lock is on.") }
            LaunchedEffect(Unit) {
                val store = Store(this@WidgetConfigureActivity)
                val household = store.householdId
                if (store.token.isNullOrBlank() || household.isNullOrBlank()) {
                    status = "Sign in before choosing a record. The widget can still be placed."
                } else {
                    dash = runCatching { withContext(Dispatchers.IO) { BudgetApi(store).dashboard(household) } }.getOrNull()
                    if (dash == null) status = "The household did not load. You can still choose the widget type."
                }
            }
            Column(Modifier.padding(24.dp)) {
                Text(status)
                WIDGET_KINDS.forEach { (id, label) ->
                    TextButton(onClick = { kind = id; recordId = "" }, modifier = Modifier.fillMaxWidth()) { Text(if (kind == id) "Selected · $label" else label) }
                }
                val records = when (kind) {
                    "category" -> dash?.optJSONArray("buckets")
                    "bill" -> dash?.optJSONArray("upcoming")
                    "goal" -> dash?.optJSONArray("goals")
                    else -> null
                }
                if (records != null) {
                    for (index in 0 until records.length()) {
                        val row = records.getJSONObject(index)
                        if (kind == "category" && row.hasText("systemRole")) continue
                        val id = if (kind == "bill") row.optString("scheduleId").ifBlank { row.optString("id") } else row.optString("id")
                        val label = row.optString(if (kind == "bill") "label" else "name")
                        if (id.isBlank()) continue
                        TextButton(onClick = { recordId = id }, modifier = Modifier.fillMaxWidth()) { Text(if (recordId == id) "Selected · $label" else label) }
                    }
                }
                Button(onClick = {
                    scope.launch {
                        Store(this@WidgetConfigureActivity).setWidgetSelection(widgetId, kind, recordId)
                        val manager = AppWidgetManager.getInstance(this@WidgetConfigureActivity)
                        updateConfigurable(this@WidgetConfigureActivity, manager, widgetId)
                        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
                        finish()
                    }
                }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Place widget") }
            }
        }
    }
}

class WidgetHostActivity : ComponentActivity() {
    private lateinit var host: AppWidgetHost
    private var pendingId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var pendingKind = ""
    private val bindPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val id = pendingId
        val kind = pendingKind
        val manager = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, ConfigurableWidget::class.java)
        val bound = result.resultCode == RESULT_OK && id != AppWidgetManager.INVALID_APPWIDGET_ID && manager.bindAppWidgetIdIfAllowed(id, provider)
        if (!bound) {
            if (id != AppWidgetManager.INVALID_APPWIDGET_ID) host.deleteAppWidgetId(id)
            bindMessage = "This device did not allow BudgetCents to bind a $kind widget. The home-screen launcher has to place it."
            pendingId = AppWidgetManager.INVALID_APPWIDGET_ID
            return@registerForActivityResult
        }
        Store(this).setWidgetSelection(id, kind, "")
        updateConfigurable(this, manager, id)
        bindMessage = "Placed the $kind widget in this host."
        boundWidgetId = id
    }
    private var bindMessage by mutableStateOf("No widget is placed yet.")
    private var boundWidgetId by mutableStateOf(AppWidgetManager.INVALID_APPWIDGET_ID)

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        host = AppWidgetHost(this, 2048)
        setContent {
            val widgetId = boundWidgetId
            Column(Modifier.padding(24.dp)) {
                Text(bindMessage)
                WIDGET_KINDS.forEach { (kind, label) ->
                    Button(onClick = { place(kind) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Place $label") }
                }
                if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                    AndroidView(
                        factory = { context -> host.createView(context, widgetId, AppWidgetManager.getInstance(context).getAppWidgetInfo(widgetId)) },
                        update = { view ->
                            val info = AppWidgetManager.getInstance(view.context).getAppWidgetInfo(widgetId)
                            view.setAppWidget(widgetId, info)
                        },
                        modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                    )
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        host.startListening()
    }

    override fun onStop() {
        host.stopListening()
        super.onStop()
    }

    private fun finishPlace(id: Int, kind: String) {
        val manager = AppWidgetManager.getInstance(this)
        Store(this).setWidgetSelection(id, kind, "")
        updateConfigurable(this, manager, id)
        bindMessage = "Placed the $kind widget in this host."
        boundWidgetId = id
    }

    private fun place(kind: String) {
        val manager = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, ConfigurableWidget::class.java)
        if (manager.isRequestPinAppWidgetSupported) {
            val pinned = manager.requestPinAppWidget(provider, null, null)
            bindMessage = if (pinned) "The launcher was asked to pin a $kind widget. Choose $kind on the next screen." else "The launcher did not pin the $kind widget."
            return
        }
        val id = host.allocateAppWidgetId()
        if (manager.bindAppWidgetIdIfAllowed(id, provider)) {
            finishPlace(id, kind)
            return
        }
        pendingId = id
        pendingKind = kind
        val request = Intent(AppWidgetManager.ACTION_APPWIDGET_BIND)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER, provider)
        val launched = runCatching { bindPermission.launch(request) }.isSuccess
        bindMessage = if (launched) "Android asked for permission to place the $kind widget." else "This device did not allow BudgetCents to bind a $kind widget. The home-screen launcher has to place it."
        if (!launched) {
            host.deleteAppWidgetId(id)
            pendingId = AppWidgetManager.INVALID_APPWIDGET_ID
        }
    }
}
