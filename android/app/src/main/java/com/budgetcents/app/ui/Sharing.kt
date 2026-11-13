package com.budgetcents.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.budgetcents.app.BudgetApi
import com.budgetcents.app.Store
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal fun writesAllowed(role: String) = role == "owner" || role == "admin" || role == "editor" || role == "contributor"
internal fun plansAllowed(role: String) = role == "owner" || role == "admin" || role == "editor"
internal fun invitesAllowed(role: String) = role == "owner" || role == "admin"

private val inviteRoles = listOf(
    "editor" to "Editor",
    "contributor" to "Contributor",
    "readonly" to "Read-only",
    "admin" to "Admin",
    "coach" to "Coach",
    "planner" to "Planner",
    "accountant" to "Accountant",
)

internal fun roleTitle(role: String) = inviteRoles.find { it.first == role }?.second ?: when (role) {
    "owner" -> "Owner"
    else -> role.replaceFirstChar { it.titlecase() }
}

@Composable
internal fun InviteScreen(
    api: BudgetApi,
    store: Store,
    token: String,
    onAccepted: (String) -> Unit,
    onDismiss: () -> Unit,
    onSwitchAccount: () -> Unit,
    onError: (String) -> Unit,
) {
    var preview by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    LaunchedEffect(token, store.token) {
        try {
            preview = withContext(Dispatchers.IO) { api.request("GET", "/api/invitations/$token", auth = !store.token.isNullOrBlank()) }
        } catch (caught: Exception) {
            onError(caught.message ?: "The invitation could not be opened.")
        }
    }
    val data = preview
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Invitation")
        if (data == null) Text("Reading the invitation…")
        else {
            Text(data.optString("message"))
            if (data.optString("householdName").isNotBlank()) Text("${data.optString("householdName")} · ${data.optString("roleLabel")}")
            if (data.optString("disclosure").isNotBlank()) Text(data.optString("disclosure"))
            if (data.optString("sharedRecords").isNotBlank()) Text(data.optString("sharedRecords"))
            if (data.optString("privateRecords").isNotBlank()) Text(data.optString("privateRecords"))
            val capabilities = data.optJSONArray("capabilities")
            if (capabilities != null) {
                for (index in 0 until capabilities.length()) Text(capabilities.optString(index))
            }
            if (data.optString("invitedEmail").isNotBlank()) Text("This invitation is for ${data.optString("invitedEmail")}.")
            Text("Balances, transactions, and other members are not shown here.")
            if (data.optBoolean("matches") == false && !store.token.isNullOrBlank()) {
                Text("You are signed in as ${data.optString("signedInEmail")}. That is not the invited email.")
                TextButton(onClick = onSwitchAccount) { Text("Sign out and use the invited email") }
            }
            if (data.optBoolean("matches") && data.has("emailVerified") && !data.optBoolean("emailVerified")) {
                Text("Verify this email before accepting. The invitation stays pending.")
            }
            val canAccept = data.optString("status") == "pending" && data.optBoolean("matches") && data.optBoolean("emailVerified")
            val canOpen = data.optString("status") == "accepted" && data.optBoolean("alreadyMember")
            if (canAccept || canOpen) {
                Button(onClick = {
                    if (busy) return@Button
                    busy = true
                    scope.launch {
                        try {
                            val result = withContext(Dispatchers.IO) { api.request("POST", "/api/invitations/$token/accept", JSONObject()) }
                            store.pendingInvite = null
                            val householdId = result.optString("householdId")
                            if (householdId.isNotBlank()) store.householdId = householdId
                            note = result.optString("note", "You joined this household.")
                            onAccepted(householdId)
                        } catch (caught: Exception) {
                            busy = false
                            onError(caught.message ?: "The invitation was not accepted.")
                        }
                    }
                }, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "Working…" else if (canOpen) "Open household" else "Accept invitation") }
            }
            if (store.token.isNullOrBlank() && data.optString("status") != "unavailable") {
                Text("Sign in or create an account, then come back. Accepting is a separate step.")
            }
        }
        if (note.isNotBlank()) Text(note)
        TextButton(onClick = onDismiss) { Text("Not now") }
    }
}

@Composable
internal fun SharingScreen(
    api: BudgetApi,
    store: Store,
    hid: String,
    role: String,
    onError: (String) -> Unit,
    onStatus: (String) -> Unit,
    onChanged: () -> Unit,
    onLeft: () -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var selectedRole by remember { mutableStateOf("coach") }
    var members by remember { mutableStateOf<JSONObject?>(null) }
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun load() {
        scope.launch {
            try {
                members = withContext(Dispatchers.IO) { api.request("GET", "/api/households/$hid/members") }
            } catch (caught: Exception) {
                onError(caught.message ?: "Sharing could not be loaded.")
            }
        }
    }
    LaunchedEffect(hid) { load() }
    val data = members
    val canInvite = invitesAllowed(role)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (data == null) "Loading sharing…" else "${data.optInt("memberCount")} of ${data.optInt("memberLimit")} members. Pending invitations are not counted.")
        Text("Revoking a link stops someone from joining. It does not remove a person who already accepted.")
        if (!writesAllowed(role)) Text("${roleTitle(role)} access can view shared records. It cannot change household money. Private accounts stay with their owner.")
        val people = data?.optJSONArray("members")
        if (people != null) {
            for (index in 0 until people.length()) {
                val person = people.getJSONObject(index)
                Text("${person.optString("displayName")} · ${person.optString("roleLabel", roleTitle(person.optString("role")))}${if (person.optBoolean("you")) " · you" else ""}")
                if (canInvite && !person.optBoolean("you") && person.optString("role") != "owner") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = {
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) {
                                        api.request("DELETE", "/api/households/$hid/members/${person.optString("id")}")
                                    }
                                    onStatus("Removed access. Shared records stay. This is different from revoking a link.")
                                    load()
                                    onChanged()
                                } catch (caught: Exception) {
                                    onError(caught.message ?: "Access was not removed.")
                                }
                            }
                        }) { Text("Remove ${person.optString("displayName")}") }
                        if (role == "owner") {
                            TextButton(onClick = {
                                scope.launch {
                                    try {
                                        val result = withContext(Dispatchers.IO) {
                                            api.request("POST", "/api/households/$hid/transfer", JSONObject().put("userId", person.optString("id")))
                                        }
                                        onStatus(result.optString("note"))
                                        load()
                                        onChanged()
                                    } catch (caught: Exception) {
                                        onError(caught.message ?: "Ownership was not transferred.")
                                    }
                                }
                            }) { Text("Transfer ownership") }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        inviteRoles.filter { it.first != person.optString("role") }.forEach { (id, label) ->
                            TextButton(onClick = {
                                scope.launch {
                                    try {
                                        withContext(Dispatchers.IO) {
                                            api.request("PATCH", "/api/households/$hid/members/${person.optString("id")}", JSONObject().put("role", id))
                                        }
                                        onStatus("${person.optString("displayName")} is now $label.")
                                        load()
                                        onChanged()
                                    } catch (caught: Exception) {
                                        onError(caught.message ?: "The role was not changed.")
                                    }
                                }
                            }) { Text(label) }
                        }
                    }
                }
            }
        }
        if (canInvite) {
            Text("Creating a link stores a copy in the local outbox. That is not email delivery.")
            OutlinedTextField(email, { email = it }, label = { Text("Invite email") }, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                inviteRoles.forEach { (id, label) ->
                    TextButton(onClick = { selectedRole = id }) { Text(if (selectedRole == id) "Selected · $label" else label) }
                }
            }
            Button(onClick = {
                if (busy) return@Button
                busy = true
                scope.launch {
                    try {
                        val invite = withContext(Dispatchers.IO) {
                            api.request("POST", "/api/households/$hid/invitations", JSONObject().put("email", email.trim()).put("role", selectedRole))
                        }
                        busy = false
                        link = "budgetcents://invite?token=${invite.optString("token")}"
                        onStatus("${invite.optString("note")} ${invite.optString("summary")}")
                        load()
                    } catch (caught: Exception) {
                        busy = false
                        onError(caught.message ?: "The invitation was not created.")
                    }
                }
            }, enabled = !busy) { Text(if (busy) "Creating…" else "Create invitation link") }
            if (link.isNotBlank()) Text(link)
            val invitations = data?.optJSONArray("invitations")
            if (invitations != null) {
                for (index in 0 until invitations.length()) {
                    val invite = invitations.getJSONObject(index)
                    Text("${invite.optString("email")} · ${invite.optString("roleLabel")} · ${invite.optString("status")}")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (invite.optString("status") == "pending") {
                            TextButton(onClick = {
                                scope.launch {
                                    try {
                                        withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/invitations/${invite.optString("id")}/revoke", JSONObject()) }
                                        onStatus("The link was revoked. A person who already joined is still a member.")
                                        load()
                                    } catch (caught: Exception) {
                                        onError(caught.message ?: "The link was not revoked.")
                                    }
                                }
                            }) { Text("Revoke link") }
                        }
                        if (invite.optString("status") != "accepted") {
                            TextButton(onClick = {
                                scope.launch {
                                    try {
                                        val next = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/invitations/${invite.optString("id")}/reissue", JSONObject()) }
                                        link = "budgetcents://invite?token=${next.optString("token")}"
                                        onStatus(next.optString("note"))
                                        load()
                                    } catch (caught: Exception) {
                                        onError(caught.message ?: "A new link was not created.")
                                    }
                                }
                            }) { Text("New link") }
                        }
                    }
                }
            }
        } else {
            Text("An owner or admin invites people and changes roles.")
        }
        TextButton(onClick = {
            scope.launch {
                try {
                    val result = withContext(Dispatchers.IO) { api.request("POST", "/api/households/$hid/leave", JSONObject()) }
                    val homes = withContext(Dispatchers.IO) { api.households() }
                    val list = homes.optJSONArray("households")
                    if (list == null || list.length() == 0) {
                        store.householdId = null
                        onStatus(result.optString("note"))
                        onLeft()
                    } else {
                        store.householdId = list.getJSONObject(0).optString("id")
                        onStatus(result.optString("note"))
                        onChanged()
                    }
                } catch (caught: Exception) {
                    onError(caught.message ?: "You are still in this household.")
                }
            }
        }) { Text("Leave this household") }
        Text("The only owner has to transfer ownership before leaving. Shared records stay.")
    }
}
