package com.budgetcents.app.ui

import java.math.BigDecimal
import java.math.RoundingMode

internal fun money(minor: Long, hidden: Boolean): String {
    if (hidden) return "••••"
    val sign = if (minor < 0) "-" else ""
    val abs = kotlin.math.abs(minor)
    return "$sign$${abs / 100}.${(abs % 100).toString().padStart(2, '0')}"
}

internal fun percentBps(text: String): Int {
    val trimmed = text.trim()
    if (!Regex("""\d+(\.\d{1,2})?""").matches(trimmed)) throw IllegalArgumentException("Enter a percent from 0 to 100 with at most two decimal places.")
    val parts = trimmed.split(".")
    val fraction = (parts.getOrElse(1) { "" } + "00").take(2)
    val bps = parts[0].toInt() * 100 + fraction.toInt()
    if (bps > 10_000) throw IllegalArgumentException("Enter a percent from 0 to 100.")
    return bps
}

internal fun parseDollars(text: String): Long =
    BigDecimal(text.trim().ifBlank { "0" }.replace("$", "").replace(",", ""))
        .movePointRight(2)
        .setScale(0, RoundingMode.HALF_UP)
        .longValueExact()
