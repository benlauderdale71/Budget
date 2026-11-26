package com.budgetcents.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

private val appearanceChoices = mapOf("light" to "Light", "dark" to "Dark", "system" to "Match phone")

internal fun isAppearanceMode(mode: String) = mode in appearanceChoices
internal val LocalPhoneAppearance = compositionLocalOf { "system" }

@Composable
internal fun AppearanceButton(onChange: (String) -> Unit) {
    val mode = LocalPhoneAppearance.current
    var open by rememberSaveable { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text("Appearance · ${appearanceChoices[mode] ?: appearanceChoices.getValue("system")}") }
    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text("Appearance") },
            text = {
                Column(Modifier.selectableGroup()) {
                    appearanceChoices.forEach { (choice, label) ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .selectable(selected = choice == mode, onClick = { onChange(choice) }, role = Role.RadioButton),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = choice == mode, onClick = null)
                            Text(label, Modifier.padding(start = 12.dp))
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { open = false }) { Text("Done") } },
        )
    }
}
