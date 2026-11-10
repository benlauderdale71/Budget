package com.budgetcents.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

class Store(context: Context) {
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

    fun enqueue(path: String, body: String) {
        val queue = JSONArray(prefs.getString("queue", "[]"))
        queue.put(JSONObject().put("path", path).put("body", body))
        prefs.edit().putString("queue", queue.toString()).apply()
    }

    fun queued(): JSONArray = JSONArray(prefs.getString("queue", "[]"))

    fun replaceQueue(queue: JSONArray) {
        prefs.edit().putString("queue", queue.toString()).apply()
    }

    fun clearSession() {
        prefs.edit().remove("token").remove("household").remove("summary").apply()
    }
}
