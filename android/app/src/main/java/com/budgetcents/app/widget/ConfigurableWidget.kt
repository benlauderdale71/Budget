package com.budgetcents.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.budgetcents.app.MainActivity
import com.budgetcents.app.R
import com.budgetcents.app.Store
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

fun updateConfigurable(context: Context, manager: AppWidgetManager, id: Int) {
    val store = Store(context)
    val kind = store.widgetKind(id)
    val facts = store.widgetFacts
    val parsed = if (facts.isBlank()) JSONObject() else JSONObject(facts)
    val title = WIDGET_KINDS.firstOrNull { it.first == kind }?.second ?: "BudgetCents"
    val body = when {
        store.token.isNullOrBlank() -> "Sign in to BudgetCents"
        store.biometric || store.privacy -> if (kind == "quick") "Add a transaction" else "Unlock BudgetCents"
        else -> parsed.optString(kind, context.getString(R.string.widget_empty))
    }
    val views = RemoteViews(context.packageName, R.layout.widget_configured)
    views.setTextViewText(R.id.widget_title, title)
    views.setTextViewText(R.id.widget_body, body)
    val host = when (kind) {
        "quick" -> "activity"
        "bill" -> "bills"
        "goal" -> "goals"
        else -> "plan"
    }
    val pending = PendingIntent.getActivity(
        context,
        id,
        Intent(Intent.ACTION_VIEW, Uri.parse("budgetcents://$host"), context, MainActivity::class.java),
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
            Column(Modifier.padding(24.dp)) {
                Text("Choose what this widget shows. Amounts stay hidden while privacy or the lock is on.")
                WIDGET_KINDS.forEach { (kind, label) ->
                    Button(onClick = {
                        Store(this@WidgetConfigureActivity).setWidgetKind(widgetId, kind)
                        val manager = AppWidgetManager.getInstance(this@WidgetConfigureActivity)
                        updateConfigurable(this@WidgetConfigureActivity, manager, widgetId)
                        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
                        finish()
                    }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text(label) }
                }
            }
        }
    }
}
