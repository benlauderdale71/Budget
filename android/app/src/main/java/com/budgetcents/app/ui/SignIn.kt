package com.budgetcents.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.MainActivity
import com.budgetcents.app.Store
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

@Composable
internal fun SignIn(
    store: Store, api: BudgetApi, activity: MainActivity, start: String, linkToken: String?, notice: String,
    onSignedIn: (opensSetup: Boolean) -> Unit,
) {
    var mode by rememberSaveable(start, linkToken) { mutableStateOf(when (start) {
        "reset" -> if (linkToken.isNullOrBlank()) "forgot" else "reset"
        "verify", "invite" -> start
        else -> "login"
    }) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var household by rememberSaveable { mutableStateOf("") }
    var tokenText by remember(start, linkToken) { mutableStateOf(linkToken.orEmpty()) }
    var code by remember { mutableStateOf("") }
    var mfa by remember { mutableStateOf(false) }
    var feedback by remember(start, linkToken) { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var serverOptions by remember { mutableStateOf(false) }
    var server by remember { mutableStateOf(store.baseUrl) }
    var activeServer by remember { mutableStateOf(store.baseUrl) }
    var flags by remember(activeServer) { mutableStateOf<JSONObject?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(activeServer) {
        flags = try {
            withContext(Dispatchers.IO) { api.request("GET", "/api/health", auth = false) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }
    fun select(next: String) {
        mode = next
        password = ""; confirm = ""; code = ""; mfa = false
        tokenText = ""; feedback = ""; failed = false
    }
    fun useServer() {
        store.baseUrl = server
        activeServer = store.baseUrl
        server = activeServer
    }
    val primaryLabel = when (mode) {
        "forgot" -> "Send reset email"
        "reset" -> "Save new password"
        "register" -> "Create household"
        "invite" -> "Create account"
        "verify" -> "Verify email"
        else -> "Sign in"
    }
    fun submit(action: String = mode, callback: Uri? = null) {
        if (busy) return
        if (action != "browser") useServer()
        feedback = ""; failed = false
        busy = true
        scope.launch {
            try {
                val address = email.trim()
                when (action) {
                    "login", "register", "invite", "demo", "browser" -> {
                        val result = withContext(Dispatchers.IO) {
                            when (action) {
                                "demo" -> api.demo()
                                "browser" -> api.request("POST", "/api/auth/android/exchange", store.websiteProof(requireNotNull(callback)), auth = false)
                                "login" -> api.login(address, password, code.trim().ifBlank { null })
                                else -> {
                                    require(password.length >= 10) { "Use at least 10 characters." }
                                    val body = JSONObject().put("email", address).put("password", password).put("displayName", name.trim())
                                    if (action == "register") body.put("householdName", household.trim())
                                    api.request("POST", "/api/auth/register", body, auth = false)
                                }
                            }
                        }
                        if (result.optBoolean("mfaRequired")) {
                            mfa = true
                            feedback = "Enter your authenticator code or a recovery code."
                        } else {
                            val user = result.getJSONObject("user")
                            val token = result.getString("token")
                            val homes = withContext(Dispatchers.IO) { api.households(token) }.getJSONArray("households")
                            store.saveSession(token, user.getString("id"), user.optString("theme", store.theme), homes.optJSONObject(0)?.getString("id"))
                            onSignedIn(action == "register" || (action in setOf("login", "browser") && user.optString("onboardingStep", "done") != "done"))
                        }
                    }
                    "forgot" -> {
                        withContext(Dispatchers.IO) { api.request("POST", "/api/auth/forgot", JSONObject().put("email", address), auth = false) }
                        feedback = if (flags?.optBoolean("devMail") == true && flags?.optBoolean("mailDelivery") == false) {
                            "If that address has an account, open development mail below for the reset link."
                        } else "If that address has an account, check your inbox and spam folder for the reset link."
                    }
                    "reset" -> {
                        require(password == confirm) { "Enter the same password in both fields." }
                        require(password.length >= 10) { "Use at least 10 characters." }
                        withContext(Dispatchers.IO) { api.request("POST", "/api/auth/reset", JSONObject().put("token", tokenText.trim()).put("password", password), auth = false) }
                        select("login")
                        feedback = "Password updated. Sign in with the new password."
                    }
                    "verify" -> {
                        withContext(Dispatchers.IO) { api.request("POST", "/api/auth/verify-email", JSONObject().put("token", tokenText.trim()), auth = false) }
                        select("login")
                        feedback = "Email verified. Sign in to continue."
                    }
                    "mail" -> {
                        val outbox = withContext(Dispatchers.IO) { api.request("GET", "/api/dev/outbox?email=${URLEncoder.encode(address, "UTF-8")}", auth = false) }
                        val messages = outbox.getJSONArray("messages")
                        feedback = (0 until messages.length()).joinToString("\n\n") { messages.getJSONObject(it).optString("body") }.ifBlank { "No message is waiting for that address." }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failed = true
                feedback = if (error is IOException) "Could not reach $activeServer. Check your connection and try again."
                           else error.message ?: "Could not complete the request."
            } finally {
                busy = false
            }
        }
    }
    val browserReturn = activity.browserReturn.value
    LaunchedEffect(browserReturn, busy) {
        if (browserReturn != null && !busy) {
            activity.browserReturn.value = null
            submit("browser", browserReturn)
        }
    }
    val needsEmail = mode in setOf("login", "register", "invite", "forgot")
    val needsPassword = mode in setOf("login", "register", "invite", "reset")
    val ready = !busy && (!needsEmail || email.isNotBlank()) && (!needsPassword || password.isNotEmpty()) &&
        (mode !in setOf("reset", "verify") || tokenText.isNotBlank()) && (mode != "reset" || confirm.isNotEmpty()) && (!mfa || code.isNotBlank())
    val onDone = KeyboardActions(onDone = { if (ready) submit() })
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            BudgetBrand()
            if (notice.isNotBlank()) Text(notice)
            Text(when (mode) {
                "forgot" -> "Enter the email you use for Budget HQ Pro."
                "reset" -> "Choose a new password for your Budget HQ Pro account."
                "verify" -> "Enter the verification token from your email."
                "invite" -> "Create an account to join an existing household. Then open your invitation to accept it."
                "register" -> "Create your Budget HQ Pro household."
                else -> "Sign in with the same email and password you use on the website."
            })
            if (mode == "register" || mode == "invite") {
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Your name") })
                if (mode == "register") OutlinedTextField(household, { household = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Household name") })
            }
            if (needsEmail) OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Email") },
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Email, imeAction = if (mode == "forgot") ImeAction.Done else ImeAction.Next), keyboardActions = onDone)
            if (mode == "reset" || mode == "verify") OutlinedTextField(tokenText, { tokenText = it }, Modifier.fillMaxWidth(), singleLine = true, enabled = !busy,
                label = { Text(if (mode == "reset") "Reset token" else "Verification token") })
            if (needsPassword) PasswordField(if (mode == "reset") "New password" else "Password", password, { password = it }, !busy,
                if (mode == "reset" || mfa) ImeAction.Next else ImeAction.Done, onDone)
            if (mode == "reset") PasswordField("Confirm password", confirm, { confirm = it }, !busy, ImeAction.Done, onDone)
            if (mfa) OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Authenticator or recovery code") },
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done), keyboardActions = onDone)
            if (feedback.isNotBlank()) Text(feedback, color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
            Button(onClick = { submit() }, modifier = Modifier.fillMaxWidth(), enabled = ready) { Text(if (busy) "Please wait…" else primaryLabel) }
            if (mode == "login") {
                TextButton(onClick = {
                    try {
                        useServer()
                        activity.startActivity(Intent(Intent.ACTION_VIEW, store.beginWebsiteSignIn()).addCategory(Intent.CATEGORY_BROWSABLE))
                    } catch (error: Exception) {
                        failed = true
                        feedback = error.message ?: "Could not open the browser."
                    }
                }, enabled = !busy) { Text("Use website sign-in") }
                TextButton(onClick = { select("forgot") }, enabled = !busy) { Text("Forgot password?") }
                TextButton(onClick = { select("register") }, enabled = !busy) { Text("Create a household") }
                TextButton(onClick = { select("invite") }, enabled = !busy) { Text("Join a household") }
                TextButton(onClick = { select("verify") }, enabled = !busy) { Text("Verify email") }
                if (flags?.optBoolean("demoLogin") == true) TextButton(onClick = { submit("demo") }, enabled = !busy) { Text("Open the sample household") }
            } else {
                if (mode == "forgot") TextButton(onClick = { select("reset") }, enabled = !busy) { Text("I have a reset token") }
                TextButton(onClick = { select("login") }, enabled = !busy) { Text("Back to sign in") }
            }
            if (flags?.optBoolean("devMail") == true) TextButton(onClick = { submit("mail") }, enabled = !busy && email.isNotBlank()) { Text("Show development mail") }
            TextButton(onClick = { serverOptions = !serverOptions }, enabled = !busy) { Text("Server settings") }
            if (serverOptions) {
                OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), enabled = !busy, singleLine = true, label = { Text("Server") },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri))
                TextButton(onClick = { useServer(); serverOptions = false }, enabled = !busy) { Text("Use server") }
            }
        }
    }
}

@Composable
private fun PasswordField(label: String, value: String, change: (String) -> Unit, enabled: Boolean, action: ImeAction, keys: KeyboardActions) {
    var visible by remember(label) { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = { change(it.filterNot { c -> c == '\n' || c == '\r' }) },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        enabled = enabled,
        singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = action),
        keyboardActions = keys,
        trailingIcon = { TextButton(onClick = { visible = !visible }) { Text(if (visible) "Hide" else "Show") } },
    )
}
