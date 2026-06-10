// SPDX-License-Identifier: AGPL-3.0

package com.thinkoff.userintent

import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.*

/**
 * REST client for the User Intent API.
 * For Wear OS, Android, and JVM-based agents.
 */
class IntentClient(
    baseUrl: String,
    private val apiKey: String,
    private val userId: String,
    private val deviceId: String? = null,
    private val timeoutMs: Int = 10000,
    private val heartbeatIntervalMs: Long = 30000L
) {
    private val baseUrl = baseUrl.trimEnd('/')
    private var heartbeatJob: Job? = null

    // --- Profile ---

    suspend fun getProfile(): Map<String, Any?> =
        request("GET", "/profile/$userId")

    // --- Intent ---

    suspend fun getIntent(): Map<String, Any?> =
        request("GET", "/intent/$userId")

    suspend fun patchDevice(fields: Map<String, Any?>): Map<String, Any?> {
        val id = deviceId ?: throw IllegalStateException("No deviceId configured")
        return request("PATCH", "/intent/$userId/$id", fields)
    }

    suspend fun patchAgent(name: String, fields: Map<String, Any?>): Map<String, Any?> =
        request("PATCH", "/intent/$userId/agents/$name", fields)

    suspend fun removeDevice(id: String? = null): Map<String, Any?> {
        val target = id ?: deviceId ?: throw IllegalStateException("No deviceId configured")
        return request("DELETE", "/intent/$userId/$target")
    }

    // --- Derived state helpers ---

    @Suppress("UNCHECKED_CAST")
    suspend fun getDerived(): Map<String, Any?> {
        val intent = getIntent()
        return intent["derived"] as? Map<String, Any?> ?: emptyMap()
    }

    suspend fun isInMeeting(): Boolean =
        getDerived()["urgency_mode"] == "text-only"

    suspend fun shouldSuppressAudio(): Boolean =
        getDerived()["suppress_audio"] == true

    suspend fun preferredDevice(): String? =
        getDerived()["preferred_device"] as? String

    // --- Heartbeat ---

    suspend fun heartbeat() {
        val id = deviceId ?: throw IllegalStateException("No deviceId configured")
        request("PATCH", "/intent/$userId/$id", mapOf("heartbeat" to true))
    }

    fun startHeartbeat(scope: CoroutineScope) {
        stopHeartbeat()
        heartbeatJob = scope.launch {
            while (isActive) {
                try { heartbeat() } catch (_: Exception) {}
                delay(maxOf(heartbeatIntervalMs, 10000L))
            }
        }
    }

    fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    // --- Internal ---

    private suspend fun request(
        method: String,
        path: String,
        body: Map<String, Any?>? = null
    ): Map<String, Any?> = withContext(Dispatchers.IO) {
        val url = URL("$baseUrl$path")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = if (method == "PATCH") "POST" else method
        if (method == "PATCH") conn.setRequestProperty("X-HTTP-Method-Override", "PATCH")
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("X-API-Key", apiKey)
        conn.setRequestProperty("Content-Type", "application/json")

        if (body != null && method != "GET" && method != "DELETE") {
            conn.doOutput = true
            conn.outputStream.use { os ->
                os.write(toJson(body).toByteArray())
            }
        }

        val code = conn.responseCode
        if (code !in 200..299) {
            val errorBody = try { conn.errorStream?.bufferedReader()?.readText() ?: "" } catch (_: Exception) { "" }
            throw IntentApiException(code, errorBody)
        }

        val responseText = try { conn.inputStream.bufferedReader().readText() } catch (_: Exception) { "" }
        if (responseText.isBlank()) return@withContext emptyMap()
        parseJson(responseText)
    }

    // Minimal JSON helpers (no external dependency)
    private fun toJson(map: Map<String, Any?>): String {
        val entries = map.entries.joinToString(",") { (k, v) ->
            "\"$k\":${valueToJson(v)}"
        }
        return "{$entries}"
    }

    private fun valueToJson(v: Any?): String = when (v) {
        null -> "null"
        is String -> "\"$v\""
        is Boolean, is Number -> "$v"
        is Map<*, *> -> toJson(@Suppress("UNCHECKED_CAST") (v as Map<String, Any?>))
        else -> "\"$v\""
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseJson(text: String): Map<String, Any?> {
        // Delegate to org.json which is available on Android
        return try {
            val obj = org.json.JSONObject(text)
            obj.keys().asSequence().associate { it to obj.opt(it) }
        } catch (_: Exception) {
            emptyMap()
        }
    }
}

class IntentApiException(val statusCode: Int, val body: String) :
    Exception("Intent API error $statusCode: $body")
