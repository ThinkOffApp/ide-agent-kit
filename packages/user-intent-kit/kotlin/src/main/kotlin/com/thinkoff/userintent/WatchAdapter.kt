// SPDX-License-Identifier: AGPL-3.0

package com.thinkoff.userintent

import kotlinx.coroutines.*

/**
 * Watch adapter for Wear OS smartwatches.
 * Publishes watch signals and reads alert mode for notification routing.
 */
class WatchAdapter(
    private val client: IntentClient,
    private val scope: CoroutineScope
) {
    private var publishJob: Job? = null

    /**
     * Publish current watch state to intent API.
     */
    suspend fun publishState(
        context: String = "active",
        screenActive: Boolean = true,
        wristRaise: Boolean = false,
        custom: Map<String, Any?>? = null
    ) {
        val fields = mutableMapOf<String, Any?>(
            "context" to context,
            "screen_active" to screenActive,
            "wrist_raise" to wristRaise
        )
        if (custom != null) fields["custom"] = custom
        client.patchDevice(fields)
    }

    /**
     * Check how an urgent alert should be delivered.
     */
    suspend fun alertMode(): AlertMode {
        val derived = client.getDerived()
        val urgency = derived["urgency_mode"] as? String ?: "normal"
        val suppressAudio = derived["suppress_audio"] == true

        return when {
            urgency == "emergency-only" -> AlertMode.SILENT
            urgency == "text-only" || suppressAudio -> AlertMode.TEXT_ONLY
            else -> AlertMode.FULL
        }
    }

    /**
     * Start periodic state publishing and heartbeat.
     */
    fun start(intervalMs: Long = 30000L) {
        stop()
        client.startHeartbeat(scope)
        publishJob = scope.launch {
            while (isActive) {
                try { publishState() } catch (_: Exception) {}
                delay(intervalMs)
            }
        }
    }

    fun stop() {
        publishJob?.cancel()
        publishJob = null
        client.stopHeartbeat()
    }
}

enum class AlertMode {
    /** Full alert: vibrate + text + optional audio */
    FULL,
    /** Text only: vibrate + text card, no audio */
    TEXT_ONLY,
    /** Silent: no alert unless emergency */
    SILENT
}
