package com.budgetcents.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object RemotePush {
    fun initialize(context: Context): Boolean {
        if (listOf(BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_SENDER_ID).any { it.isBlank() }) return false
        if (FirebaseApp.getApps(context).isEmpty()) FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setApplicationId(BuildConfig.FIREBASE_APP_ID)
            .setApiKey(BuildConfig.FIREBASE_API_KEY).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        return true
    }

    suspend fun enroll(context: Context, store: Store, api: BudgetApi) {
        require(!store.token.isNullOrBlank()) { "Sign in before enrolling this phone." }
        require(initialize(context)) { "This build has no Firebase app configuration. Remote push is unavailable." }
        require(Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) { "Allow notifications in Android settings before enrolling this phone." }
        val owner = store.userId
        withContext(Dispatchers.IO) { api.request("POST", "/api/messages/enrollment", JSONObject().put("channel", "push").put("destinationLabel", "Android phone").put("consent", true)) }
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true
        val token = suspendCancellableCoroutine<String> { continuation ->
            messaging.token.addOnSuccessListener { if (continuation.isActive) continuation.resume(it) }
                .addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(it) }
        }
        require(owner == store.userId && !store.token.isNullOrBlank()) { "The signed-in account changed. Enroll again." }
        withContext(Dispatchers.IO) {
            val device = store.remoteDeviceId ?: api.request("POST", "/api/devices", JSONObject().put("name", "Android phone").put("platform", "android")).getString("id")
            api.request("POST", "/api/devices/$device/push-token", JSONObject().put("token", token))
            store.remoteDeviceId = device
            store.remotePushEnabled = true
        }
    }

    fun disable(context: Context, store: Store) {
        store.remotePushEnabled = false
        store.remoteDeviceId = null
        if (initialize(context)) { FirebaseMessaging.getInstance().isAutoInitEnabled = false; FirebaseMessaging.getInstance().deleteToken() }
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }
}

class BudgetApplication : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        if (RemotePush.initialize(this) && !Store(this).remotePushEnabled) FirebaseMessaging.getInstance().isAutoInitEnabled = false
    }
}

class RemotePushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val store = Store(applicationContext)
        val device = store.remoteDeviceId ?: return
        if (!store.remotePushEnabled || store.token.isNullOrBlank()) return
        try { BudgetApi(store).request("POST", "/api/devices/$device/push-token", JSONObject().put("token", token)) } catch (_: Exception) { /* Retry by enrolling the phone again; never log a device token. */ }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val store = Store(applicationContext)
        if (!store.remotePushEnabled || store.token.isNullOrBlank() || message.data["kind"] != "budgetcents_alert") return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        val channel = NotificationChannel("budgetcents_remote", "BudgetCents remote alerts", NotificationManager.IMPORTANCE_DEFAULT)
        channel.lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
        manager.createNotificationChannel(channel)
        if (manager.getNotificationChannel("budgetcents_remote")?.importance == NotificationManager.IMPORTANCE_NONE) return
        val intent = Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse("budgetcents://alerts"))
        val pending = PendingIntent.getActivity(this, 730, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "budgetcents_remote").setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("BudgetCents").setContentText("Open BudgetCents to review your notification.")
            .setContentIntent(pending).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        manager.notify(730, notification)
        val event = message.data["eventId"] ?: return
        if (!event.matches(Regex("[A-Za-z0-9-]{1,100}"))) return
        try { BudgetApi(store).request("POST", "/api/notifications/remote/$event/received", JSONObject()) } catch (_: Exception) { /* Without an acknowledged receipt the server keeps acceptance unproven. */ }
    }
}
