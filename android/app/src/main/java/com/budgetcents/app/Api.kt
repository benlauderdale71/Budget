package com.budgetcents.app

import org.json.JSONObject
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

class ApiException(val status: Int, message: String) : Exception(message)

class BudgetApi(private val store: Store) {
    fun login(email: String, password: String, code: String? = null): JSONObject {
        val body = JSONObject().put("email", email).put("password", password)
        if (!code.isNullOrBlank()) body.put("code", code)
        return request("POST", "/api/auth/login", body, auth = false)
    }
    fun demo() = request("POST", "/api/auth/demo", JSONObject(), auth = false)
    fun households() = request("GET", "/api/households")
    fun dashboard(householdId: String) = request("GET", "/api/households/$householdId/dashboard")
    fun transactions(householdId: String) = request("GET", "/api/households/$householdId/transactions?limit=100")
    fun createTransaction(householdId: String, body: JSONObject) = request("POST", "/api/households/$householdId/transactions", body)

    fun uploadReceipt(householdId: String, transactionId: String, jpeg: ByteArray) =
        uploadAttachment(householdId, jpeg, "image/jpeg", transactionId)

    fun uploadAttachment(householdId: String, bytes: ByteArray, mime: String, transactionId: String? = null): JSONObject {
        val boundary = "----BudgetCentsBoundary"
        val filename = when (mime) {
            "image/png" -> "receipt.png"
            "application/pdf" -> "receipt.pdf"
            else -> "receipt.jpg"
        }
        val connection = (URL("$base/api/households/$householdId/attachments").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 12000
            readTimeout = 30000
            doOutput = true
            setRequestProperty("authorization", "Bearer ${store.token}")
            setRequestProperty("content-type", "multipart/form-data; boundary=$boundary")
        }
        connection.outputStream.use { out ->
            fun write(text: String) = out.write(text.toByteArray(StandardCharsets.UTF_8))
            if (!transactionId.isNullOrBlank()) write("--$boundary\r\nContent-Disposition: form-data; name=\"transactionId\"\r\n\r\n$transactionId\r\n")
            write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$filename\"\r\nContent-Type: $mime\r\n\r\n")
            out.write(bytes)
            write("\r\n--$boundary--\r\n")
        }
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        val json = if (text.isBlank()) JSONObject() else JSONObject(text)
        if (connection.responseCode !in 200..299) throw ApiException(connection.responseCode, json.optString("error", "The receipt was not stored."))
        return json
    }

    private val base get() = store.baseUrl
    fun assign(householdId: String, body: JSONObject) = request("POST", "/api/households/$householdId/assignments", body)

    fun request(method: String, path: String, body: JSONObject? = null, auth: Boolean = true): JSONObject {
        val connection = (URL(store.baseUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12000
            readTimeout = 20000
            setRequestProperty("accept", "application/json")
            if (auth) setRequestProperty("authorization", "Bearer ${store.token}")
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json")
                OutputStreamWriter(outputStream, StandardCharsets.UTF_8).use { it.write(body.toString()) }
            }
        }
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        val json = if (text.isBlank()) JSONObject() else JSONObject(text)
        if (connection.responseCode !in 200..299) throw ApiException(connection.responseCode, json.optString("error", "Request failed"))
        return json
    }
}

/** JSON null is not a value. Android's optString turns it into the word "null". */
fun JSONObject.hasText(key: String): Boolean = !isNull(key) && optString(key).isNotBlank()
