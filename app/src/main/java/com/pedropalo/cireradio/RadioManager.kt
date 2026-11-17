package com.pedropalo.cireradio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.random.Random

class RadioManager(
    private val context: Context,
    private val listener: Listener
) {
    companion object {
        var instance: RadioManager? = null
            private set

        const val SAMPLE_RATE = 16000
        const val BUFFER_CHUNK_SIZE = 640 // 20ms of 16-bit 16kHz mono audio
        const val DEFAULT_SERVER_URL = "wss://radio.cire-unah.site"
    }

    interface Listener {
        fun onJoinedChannel(channel: String, uid: Int)
        fun onRemoteUserTalking(isTalking: Boolean, uid: Int)
        fun onConnectionChanged(isConnected: Boolean, message: String)
        fun onEngineError(errCode: Int, message: String)
        fun onChannelListUpdated()
    }

    var serverUrl: String = DEFAULT_SERVER_URL
        private set
    var currentChannel: String? = null
        private set
    var isJoined: Boolean = false
        private set
    var isTransmitting: Boolean = false
        private set
    var isConnected: Boolean = false
        private set

    var onTransmissionStateChangedListener: ((Boolean) -> Unit)? = null

    val myUid: Int = Random.nextInt(100000, 999999)

    private val mainHandler = Handler(Looper.getMainLooper())
    private var toneGen: ToneGenerator? = null

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var isRecording = false
    private var recordThread: Thread? = null

    init {
        instance = this
        try {
            toneGen = ToneGenerator(AudioManager.STREAM_MUSIC, 85)
        } catch (e: Exception) {
            e.printStackTrace()
        }
        initAudioTrack()
    }

    private fun initAudioTrack() {
        try {
            val minBuf = AudioTrack.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            val builder = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(minBuf) // Minimal hardware buffer for zero latency
                .setTransferMode(AudioTrack.MODE_STREAM)

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            }

            audioTrack = builder.build()
            audioTrack?.play()
            ensureLoudspeaker()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun initEngine(url: String = DEFAULT_SERVER_URL): Boolean {
        serverUrl = url.trim()
        connectWebSocket()
        return true
    }

    private fun connectWebSocket() {
        if (webSocket != null) return

        val request = Request.Builder()
            .url(serverUrl)
            .build()

        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                isConnected = true
                mainHandler.post {
                    listener.onConnectionChanged(true, "Conectado al servidor")
                    // If we had a channel pending, join it now
                    currentChannel?.let { joinChannel(it) }
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleJsonMessage(text)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // Incoming real-time audio chunk from another radio!
                try {
                    val raw = bytes.toByteArray()
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                        audioTrack?.write(raw, 0, raw.size, AudioTrack.WRITE_NON_BLOCKING)
                    } else {
                        audioTrack?.write(raw, 0, raw.size)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                ws.close(1000, null)
                handleDisconnect("Desconectando: $reason")
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                handleDisconnect("Fallo de red: ${t.message}")
            }
        })
    }

    private fun handleDisconnect(reason: String) {
        isConnected = false
        isJoined = false
        webSocket = null
        mainHandler.post {
            listener.onConnectionChanged(false, reason)
        }
        // Auto-reconnect after 3 seconds
        mainHandler.postDelayed({
            if (instance != null && !isConnected) {
                connectWebSocket()
            }
        }, 3000)
    }

    private fun handleJsonMessage(jsonStr: String) {
        try {
            val json = JSONObject(jsonStr)
            when (json.optString("type")) {
                "joined" -> {
                    isJoined = true
                    val ch = json.optString("channel", currentChannel ?: "")
                    mainHandler.post {
                        listener.onJoinedChannel(ch, myUid)
                        ensureLoudspeaker()
                    }
                }
                "talk_start" -> {
                    val speakerUid = json.optInt("uid", 0)
                    if (speakerUid != myUid) {
                        try {
                            audioTrack?.pause()
                            audioTrack?.flush()
                            audioTrack?.play()
                        } catch (e: Exception) {}
                        mainHandler.post {
                            ensureLoudspeaker()
                            listener.onRemoteUserTalking(true, speakerUid)
                        }
                    }
                }
                "talk_stop" -> {
                    val speakerUid = json.optInt("uid", 0)
                    if (speakerUid != myUid) {
                        try {
                            audioTrack?.pause()
                            audioTrack?.flush()
                            audioTrack?.play()
                        } catch (e: Exception) {}
                        mainHandler.post {
                            listener.onRemoteUserTalking(false, speakerUid)
                        }
                    }
                }
                "channel_created" -> {
                    mainHandler.post {
                        listener.onChannelListUpdated()
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun joinChannel(channelName: String) {
        currentChannel = channelName
        if (!isConnected || webSocket == null) {
            connectWebSocket()
            return
        }

        val json = JSONObject().apply {
            put("type", "join")
            put("channel", channelName)
            put("uid", myUid)
        }
        webSocket?.send(json.toString())
    }

    fun switchChannel(newChannelName: String) {
        if (currentChannel == newChannelName && isJoined) return
        joinChannel(newChannelName)
    }

    fun broadcastChannelCreated() {
        try {
            val json = JSONObject().apply {
                put("type", "channel_created")
            }
            webSocket?.send(json.toString())
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @SuppressLint("MissingPermission")
    fun startTransmitting() {
        if (isTransmitting) return
        isTransmitting = true

        playMicBeep()

        // Notify server that we started talking
        val json = JSONObject().apply {
            put("type", "talk_start")
            put("channel", currentChannel ?: "General")
            put("uid", myUid)
        }
        webSocket?.send(json.toString())

        startAudioRecording()

        mainHandler.post {
            onTransmissionStateChangedListener?.invoke(true)
        }
    }

    fun stopTransmitting() {
        if (!isTransmitting) return
        isTransmitting = false

        stopAudioRecording()

        // Notify server that we stopped talking
        val json = JSONObject().apply {
            put("type", "talk_stop")
            put("channel", currentChannel ?: "General")
            put("uid", myUid)
        }
        webSocket?.send(json.toString())

        playRogerBeep()

        mainHandler.post {
            onTransmissionStateChangedListener?.invoke(false)
        }
    }

    @SuppressLint("MissingPermission")
    private fun startAudioRecording() {
        try {
            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            val recBuilder = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(SAMPLE_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build()
                    )
                    .setBufferSizeInBytes(minBuf)
            } else null

            audioRecord = recBuilder?.build() ?: AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf
            )

            try {
                if (AcousticEchoCanceler.isAvailable()) {
                    AcousticEchoCanceler.create(audioRecord!!.audioSessionId)?.enabled = true
                }
                if (NoiseSuppressor.isAvailable()) {
                    NoiseSuppressor.create(audioRecord!!.audioSessionId)?.enabled = true
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }

            audioRecord?.startRecording()
            isRecording = true

            recordThread = Thread {
                val buffer = ByteArray(BUFFER_CHUNK_SIZE)
                while (isRecording && isTransmitting) {
                    val read = audioRecord?.read(buffer, 0, buffer.size) ?: -1
                    if (read > 0 && webSocket != null) {
                        webSocket?.send(buffer.toByteString(0, read))
                    }
                }
            }.apply {
                priority = Thread.MAX_PRIORITY
                start()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun stopAudioRecording() {
        isRecording = false
        try {
            recordThread?.interrupt()
            recordThread = null
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun ensureLoudspeaker() {
        try {
            val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.isSpeakerphoneOn = true

            val maxVoice = audioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
            audioManager.setStreamVolume(AudioManager.STREAM_VOICE_CALL, maxVoice, 0)

            val maxMusic = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxMusic, 0)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun playMicBeep() {
        try {
            toneGen?.startTone(ToneGenerator.TONE_PROP_BEEP, 70)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun playRogerBeep() {
        try {
            toneGen?.startTone(ToneGenerator.TONE_SUP_RADIO_ACK, 120)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    fun destroyEngine() {
        if (instance == this) {
            instance = null
        }
        stopTransmitting()
        try {
            webSocket?.close(1000, "App cerrada")
            webSocket = null
            audioTrack?.stop()
            audioTrack?.release()
            audioTrack = null
            toneGen?.release()
            toneGen = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
