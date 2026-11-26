package com.budgetcents.app.ui

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

internal fun deviceResponse(type: String, status: Int, bytes: ByteArray, headers: Map<String,String> = emptyMap()) =
    WebResourceResponse(type, if (type.startsWith("text/") || type.contains("json") || type.contains("javascript")) "UTF-8" else null,
        status, if (status == 200) "OK" else "Unavailable", headers, ByteArrayInputStream(bytes))

/** Queries public listing data only. All destinations and the product query come from the signed APK. */
internal class DeviceCatalog(context: Context) {
    private val config = context.assets.open("resale-catalogs.json").bufferedReader().use { JSONObject(it.readText()) }
    private val sources = config.getJSONArray("sources").let { rows ->
        (0 until rows.length()).map(rows::getJSONObject).associateBy { it.getString("id") }
    }

    fun lookup(uri: Uri): WebResourceResponse {
        val source = sources[uri.getQueryParameter("source").orEmpty()] ?: return deviceResponse("application/json",400,byteArrayOf())
        val term = uri.getQueryParameter("q")?.trim().orEmpty()
        if (term.length !in 2..120) return deviceResponse("application/json",400,byteArrayOf())
        val shopify = source.getString("kind") == "shopify"
        val url = Uri.Builder().scheme("https").authority(source.getString("host")).apply {
            if (shopify) path(config.getString("storefrontPath")) else {
                path("/wp-json/wc/store/v1/products")
                appendQueryParameter("search",term); appendQueryParameter("per_page","18")
                appendQueryParameter("stock_status","instock"); appendQueryParameter("_fields","name,permalink,is_in_stock,prices")
            }
        }.build()
        return try {
            val conn = URL(url.toString()).openConnection() as HttpURLConnection
            try {
                conn.connectTimeout=8500; conn.readTimeout=8500; conn.instanceFollowRedirects=false
                conn.setRequestProperty("Accept","application/json")
                if (shopify) {
                    conn.requestMethod="POST"; conn.doOutput=true; conn.setRequestProperty("Content-Type","application/json")
                    val body=JSONObject().put("query",config.getString("query")).put("variables",JSONObject().put("term",term))
                    conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                }
                require(conn.responseCode in 200..299)
                val data=conn.inputStream.bufferedReader().use { it.readText() }
                if (shopify) JSONObject(data).getJSONObject("data").getJSONObject("search").getJSONArray("nodes") else JSONArray(data)
                deviceResponse("application/json",200,data.toByteArray(),mapOf("Cache-Control" to "no-store"))
            } finally { conn.disconnect() }
        } catch (_: Exception) { deviceResponse("application/json",503,byteArrayOf()) }
    }
}
