package com.pedropalo.cireradio

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class RadioChannel(
    val id: String,
    val name: String,
    val description: String,
    val isPrivate: Boolean = false,
    val pin: String? = null,
    val creatorDeviceId: String = ""
)

object SupabaseClient {
    private const val SUPABASE_URL = "https://cdqdpnntmiirvhycufcp.supabase.co"
    private const val ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkcWRwbm50bWlpcnZoeWN1ZmNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1ODA2OTAsImV4cCI6MjExMDE1NjY5MH0.TfU_T25peO81chK6rGxjWltkgp2Od7oKwuqYNfL6dXs"

    val DEFAULT_CHANNELS = listOf(
        RadioChannel("1", "Canal 1 (General)", "Frecuencia principal Volkee", false, null, "")
    )

    private val httpClient = OkHttpClient()

    suspend fun getChannels(): List<RadioChannel> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$SUPABASE_URL/rest/v1/cire_channels?select=*&order=created_at.asc")
            .addHeader("apikey", ANON_KEY)
            .addHeader("Authorization", "Bearer $ANON_KEY")
            .build()

        val channels = mutableListOf<RadioChannel>()
        try {
            val response = httpClient.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext DEFAULT_CHANNELS
            val jsonArray = JSONArray(body)
            for (i in 0 until jsonArray.length()) {
                val obj = jsonArray.getJSONObject(i)
                channels.add(
                    RadioChannel(
                        id = obj.optString("id", "${i + 1}"),
                        name = obj.getString("name"),
                        description = if (obj.optBoolean("is_private", false)) "Canal privado protegido con PIN" else "Canal público Volkee",
                        isPrivate = obj.optBoolean("is_private", false),
                        pin = if (obj.has("pin") && !obj.isNull("pin")) obj.getString("pin") else null,
                        creatorDeviceId = obj.optString("creator_device_id", "")
                    )
                )
            }
        } catch (e: Exception) {
            e.printStackTrace()
            return@withContext DEFAULT_CHANNELS
        }
        if (channels.isEmpty()) DEFAULT_CHANNELS else channels
    }

    suspend fun createChannel(name: String, isPrivate: Boolean, pin: String?, deviceId: String): Result<RadioChannel> = withContext(Dispatchers.IO) {
        val json = JSONObject().apply {
            put("name", name.trim())
            put("is_private", isPrivate)
            if (isPrivate && !pin.isNullOrBlank()) {
                put("pin", pin.trim())
            } else {
                put("pin", "")
            }
            put("creator_device_id", deviceId)
        }

        val request = Request.Builder()
            .url("$SUPABASE_URL/rest/v1/cire_channels")
            .addHeader("apikey", ANON_KEY)
            .addHeader("Authorization", "Bearer $ANON_KEY")
            .addHeader("Prefer", "return=representation")
            .post(json.toString().toRequestBody("application/json".toMediaType()))
            .build()

        try {
            val response = httpClient.newCall(request).execute()
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                return@withContext Result.failure(Exception("HTTP ${response.code}: $body"))
            }
            val array = JSONArray(body)
            if (array.length() > 0) {
                val obj = array.getJSONObject(0)
                val channel = RadioChannel(
                    id = obj.optString("id", "0"),
                    name = obj.getString("name"),
                    description = if (isPrivate) "Canal privado protegido con PIN" else "Canal público Volkee",
                    isPrivate = obj.optBoolean("is_private", false),
                    pin = if (obj.has("pin") && !obj.isNull("pin")) obj.getString("pin") else null,
                    creatorDeviceId = deviceId
                )
                return@withContext Result.success(channel)
            }
            Result.failure(Exception("Respuesta vacía del servidor"))
        } catch (e: Exception) {
            e.printStackTrace()
            Result.failure(e)
        }
    }

    suspend fun deleteChannel(channelId: String): Result<Boolean> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$SUPABASE_URL/rest/v1/cire_channels?id=eq.$channelId")
            .addHeader("apikey", ANON_KEY)
            .addHeader("Authorization", "Bearer $ANON_KEY")
            .delete()
            .build()

        try {
            val response = httpClient.newCall(request).execute()
            if (response.isSuccessful) {
                Result.success(true)
            } else {
                val body = response.body?.string() ?: ""
                Result.failure(Exception("HTTP ${response.code}: $body"))
            }
        } catch (e: Exception) {
            e.printStackTrace()
            Result.failure(e)
        }
    }
}
