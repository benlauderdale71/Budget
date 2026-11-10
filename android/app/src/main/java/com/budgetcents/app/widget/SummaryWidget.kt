package com.budgetcents.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.budgetcents.app.MainActivity
import com.budgetcents.app.R
import com.budgetcents.app.Store

class SummaryWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val store = Store(context)
        val body = when {
            store.summary.isBlank() -> context.getString(R.string.widget_empty)
            store.privacy -> "Amounts hidden"
            else -> store.summary
        }
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_summary)
            views.setTextViewText(R.id.widget_title, "BudgetCents")
            views.setTextViewText(R.id.widget_body, body)
            val pending = PendingIntent.getActivity(
                context, 0, Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            views.setOnClickPendingIntent(R.id.widget_root, pending)
            manager.updateAppWidget(id, views)
        }
    }
}

fun refreshWidgets(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val ids = manager.getAppWidgetIds(android.content.ComponentName(context, SummaryWidget::class.java))
    if (ids.isNotEmpty()) SummaryWidget().onUpdate(context, manager, ids)
}
