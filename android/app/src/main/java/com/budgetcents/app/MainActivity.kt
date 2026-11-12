package com.budgetcents.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.budgetcents.app.ui.BudgetApp

class MainActivity : FragmentActivity() {
    val navigation = mutableStateOf("home")
    val recordId = mutableStateOf<String?>(null)
    var receiptBytes: ByteArray? = null
    var onReceipt: ((ByteArray) -> Unit)? = null
    var onFile: ((ByteArray) -> Unit)? = null

    private val file = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@registerForActivityResult
        val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@registerForActivityResult
        onFile?.invoke(bytes)
    }

    private val camera = registerForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
        if (bitmap == null) return@registerForActivityResult
        val stream = java.io.ByteArrayOutputStream()
        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, stream)
        val bytes = stream.toByteArray()
        receiptBytes = bytes
        onReceipt?.invoke(bytes)
    }
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) camera.launch(null)
    }
    val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        ensureChannel()
        navigation.value = savedInstanceState?.getString("navigation") ?: startHost(intent)
        recordId.value = savedInstanceState?.getString("recordId") ?: recordId(intent)
        setContent { BudgetApp(this, navigation.value, linkToken(intent), recordId.value) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("navigation", navigation.value)
        recordId.value?.let { outState.putString("recordId", it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        navigation.value = startHost(intent)
        recordId.value = recordId(intent)
    }

    private fun startHost(intent: Intent?): String {
        val data = intent?.data
        val pathToken = invitePathToken(data)
        val host = data?.host
        val mapped = when (host) {
            "transaction" -> "activity"
            "bill" -> "bills"
            "goal" -> "goals"
            else -> host
        }
        return if (mapped == "invite" || pathToken != null) "invite" else mapped ?: "home"
    }

    private fun recordId(intent: Intent?): String? {
        val data = intent?.data ?: return null
        return data.getQueryParameter("id") ?: data.lastPathSegment?.takeIf { data.host == "transaction" || data.host == "bill" || data.host == "goal" }
    }

    private fun linkToken(intent: Intent?): String? {
        val data = intent?.data
        return data?.getQueryParameter("token")
            ?: if (data?.host == "invite") data.lastPathSegment?.takeIf { it.isNotBlank() && it != "invite" } else null
            ?: invitePathToken(data)
    }

    private fun invitePathToken(data: Uri?): String? {
        val segments = data?.pathSegments ?: return null
        val invite = segments.indexOf("invite")
        return if (invite >= 0 && invite + 1 < segments.size) segments[invite + 1] else null
    }

    fun pickReceipt() {
        file.launch("*/*")
    }

    fun captureReceipt() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera.launch(null)
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    fun unlock(onSuccess: () -> Unit, onError: (String) -> Unit) {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.BIOMETRIC_WEAK
        val manager = BiometricManager.from(this)
        if (manager.canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            onError("This device has no biometric unlock. You can keep using the password sign-in.")
            return
        }
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onSuccess()
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onError(errString.toString())
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Unlock BudgetCents").setNegativeButtonText("Cancel").setAllowedAuthenticators(authenticators).build())
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel("budgetcents", "BudgetCents", NotificationManager.IMPORTANCE_DEFAULT)
        channel.description = "In-app BudgetCents alerts. This is not remote push."
        channel.lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET
        manager.createNotificationChannel(channel)
    }
}
