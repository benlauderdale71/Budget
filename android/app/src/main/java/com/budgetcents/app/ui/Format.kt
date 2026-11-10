package com.budgetcents.app.ui

import java.math.BigDecimal
import java.math.RoundingMode

internal fun money(minor: Long, hidden: Boolean): String {
    if (hidden) return "••••"
    val sign = if (minor < 0) "-" else ""
    val abs = kotlin.math.abs(minor)
    return "$sign$${abs / 100}.${(abs % 100).toString().padStart(2, '0')}"
}

internal fun parseDollars(text: String): Long =
    BigDecimal(text.trim().ifBlank { "0" }.replace("$", "").replace(",", ""))
        .movePointRight(2)
        .setScale(0, RoundingMode.HALF_UP)
        .longValueExact()
