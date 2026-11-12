package com.budgetcents.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

class Store(private val context: Context) {
    private val prefs: SharedPreferences = run {
        val master = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "budgetcents",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var baseUrl: String
        get() = prefs.getString("base", "http://10.0.2.2:8787") ?: "http://10.0.2.2:8787"
        set(value) { prefs.edit().putString("base", value.trim().trimEnd('/')).apply() }
    var token: String?
        get() = prefs.getString("token", null)
        set(value) { prefs.edit().putString("token", value).apply() }
    var householdId: String?
        get() = prefs.getString("household", null)
        set(value) { prefs.edit().putString("household", value).apply() }
    var biometric: Boolean
        get() = prefs.getBoolean("biometric", false)
        set(value) { prefs.edit().putBoolean("biometric", value).apply() }
    var privacy: Boolean
        get() = prefs.getBoolean("privacy", false)
        set(value) { prefs.edit().putBoolean("privacy", value).apply() }
    var summary: String
        get() = prefs.getString("summary", "") ?: ""
        set(value) { prefs.edit().putString("summary", value).apply() }
    var userId: String?
        get() = prefs.getString("userId", null)
        set(value) { prefs.edit().putString("userId", value).apply() }
    var remotePushEnabled: Boolean
        get() = prefs.getBoolean("remotePush", false)
        set(value) { prefs.edit().putBoolean("remotePush", value).apply() }
    var remoteDeviceId: String?
        get() = prefs.getString("remoteDevice", null)
        set(value) { prefs.edit().putString("remoteDevice", value).apply() }
    var theme: String
        get() = prefs.getString("theme", "system") ?: "system"
        set(value) { prefs.edit().putString("theme", value).apply() }
    var pendingInvite: String?
        get() = prefs.getString("invite", null)
        set(value) {
            if (value.isNullOrBlank()) prefs.edit().remove("invite").apply()
            else prefs.edit().putString("invite", value).apply()
        }

    fun enqueue(path: String, body: String) {
        val owner = userId ?: return
        val parsed = JSONObject(body)
        if (parsed.optString("opId").isBlank()) parsed.put("opId", java.util.UUID.randomUUID().toString())
        val queue = JSONArray(prefs.getString("queue", "[]"))
        queue.put(JSONObject().put("path", path).put("body", parsed.toString()).put("ownerId", owner).put("opId", parsed.getString("opId")))
        prefs.edit().putString("queue", queue.toString()).apply()
    }

    fun queued(): JSONArray = JSONArray(prefs.getString("queue", "[]"))

    fun replaceQueue(queue: JSONArray) {
        prefs.edit().putString("queue", queue.toString()).apply()
    }

    fun pendingForCurrentUser(): List<JSONObject> {
        val owner = userId ?: return emptyList()
        val queue = queued()
        return (0 until queue.length()).map { queue.getJSONObject(it) }.filter { it.optString("ownerId") == owner }
    }

    fun widgetKind(id: Int): String = prefs.getString("widget-kind-$id", "category") ?: "category"

    fun widgetRecord(id: Int): String = prefs.getString("widget-record-$id", "") ?: ""

    fun setWidgetKind(id: Int, kind: String) {
        prefs.edit().putString("widget-kind-$id", kind).apply()
    }

    fun setWidgetSelection(id: Int, kind: String, recordId: String) {
        prefs.edit().putString("widget-kind-$id", kind).putString("widget-record-$id", recordId).apply()
    }

    var widgetFacts: String
        get() = prefs.getString("widgetFacts", "") ?: ""
        set(value) { prefs.edit().putString("widgetFacts", value).apply() }

    fun saveDashboardCache(json: String) {
        val user = userId ?: return
        val household = householdId ?: return
        prefs.edit().putString("cacheUser", user).putString("cacheHousehold", household).putString("cacheJson", json).putLong("cacheAt", System.currentTimeMillis()).apply()
    }

    fun cachedDashboard(): String? {
        val user = userId ?: return null
        val household = householdId ?: return null
        if (prefs.getString("cacheUser", null) != user || prefs.getString("cacheHousehold", null) != household) return null
        val at = prefs.getLong("cacheAt", 0L)
        if (at == 0L || System.currentTimeMillis() - at > 7L * 24 * 60 * 60 * 1000) {
            clearCache()
            return null
        }
        return prefs.getString("cacheJson", null)
    }

    fun clearCache() {
        prefs.edit().remove("cacheUser").remove("cacheHousehold").remove("cacheJson").remove("cacheAt").remove("widgetFacts").remove("summary").apply()
    }

    fun clearSession() {
        RemotePush.disable(context, this)
        clearCache()
        prefs.edit().remove("token").remove("household").remove("summary").remove("userId").remove("remotePush").remove("remoteDevice").apply()
    }

    fun hasNotified(id: String): Boolean = notifiedAlerts().contains(id)

    fun markNotified(id: String) {
        if (id.isBlank() || hasNotified(id)) return
        val ids = notifiedAlerts().toMutableList()
        ids.add(id)
        val kept = if (ids.size > 100) ids.takeLast(100) else ids
        prefs.edit().putString("notifiedAlerts", JSONArray(kept).toString()).apply()
    }

    private fun notifiedAlerts(): List<String> {
        val array = JSONArray(prefs.getString("notifiedAlerts", "[]"))
        return (0 until array.length()).map { array.optString(it) }.filter { it.isNotBlank() }
    }
}
