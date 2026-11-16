package com.pedropalo.cireradio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.media.VolumeProvider
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.view.KeyEvent
import androidx.core.app.NotificationCompat

class WalkieTalkieService : Service() {
    companion object {
        const val CHANNEL_ID = "cire_radio_channel_id"
        const val NOTIFICATION_ID = 2001
        const val ACTION_START = "ACTION_START"
        const val ACTION_STOP = "ACTION_STOP"
        const val EXTRA_CHANNEL_NAME = "EXTRA_CHANNEL_NAME"

        fun startService(context: Context, channelName: String = "Canal 1 (General)") {
            val intent = Intent(context, WalkieTalkieService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CHANNEL_NAME, channelName)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val intent = Intent(context, WalkieTalkieService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var mediaSession: MediaSession? = null
    private var currentActiveChannelName: String = "Canal 1 (General)"
    private var isPttActiveFromVolume = false

    private val mainHandler = Handler(Looper.getMainLooper())
    private val pttReleaseRunnable = Runnable {
        if (isPttActiveFromVolume) {
            isPttActiveFromVolume = false
            RadioManager.instance?.stopTransmitting()
            updateNotificationTransmitting(false)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireLocks()
        setupMediaSession()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            System.exit(0)
            return START_NOT_STICKY
        }

        currentActiveChannelName = intent?.getStringExtra(EXTRA_CHANNEL_NAME) ?: "Canal 1 (General)"
        val notification = buildNotification(currentActiveChannelName, RadioManager.instance?.isTransmitting ?: false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                }
                startForeground(NOTIFICATION_ID, notification, type)
            } catch (e: Exception) {
                startForeground(NOTIFICATION_ID, notification)
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        return START_STICKY
    }

    private fun setupMediaSession() {
        try {
            val volumeProvider = object : VolumeProvider(VOLUME_CONTROL_RELATIVE, 100, 50) {
                override fun onAdjustVolume(direction: Int) {
                    if (direction < 0) {
                        // Hardware Volume Down pressed
                        onVolumeDownTriggered()
                    } else if (direction > 0) {
                        // Hardware Volume Up pressed
                        try {
                            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                            am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_RAISE, 0)
                            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0)
                        } catch (e: Exception) {
                            e.printStackTrace()
                        }
                    }
                }
            }

            mediaSession = MediaSession(this, "CireRadioLockSession").apply {
                setPlaybackToRemote(volumeProvider)
                val state = PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)
                    .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                    .build()
                setPlaybackState(state)

                setCallback(object : MediaSession.Callback() {
                    override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                        val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                        }
                        if (keyEvent != null && (keyEvent.keyCode == KeyEvent.KEYCODE_HEADSETHOOK || keyEvent.keyCode == 286)) {
                            if (keyEvent.action == KeyEvent.ACTION_DOWN && keyEvent.repeatCount == 0) {
                                RadioManager.instance?.startTransmitting()
                                updateNotificationTransmitting(true)
                            } else if (keyEvent.action == KeyEvent.ACTION_UP) {
                                RadioManager.instance?.stopTransmitting()
                                updateNotificationTransmitting(false)
                            }
                            return true
                        }
                        return super.onMediaButtonEvent(mediaButtonIntent)
                    }
                })
                isActive = true
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun onVolumeDownTriggered() {
        mainHandler.post {
            wakeScreenOnPtt()
            if (!isPttActiveFromVolume) {
                isPttActiveFromVolume = true
                RadioManager.instance?.startTransmitting()
                updateNotificationTransmitting(true)
            }
            // Reset watchdog timer
            mainHandler.removeCallbacks(pttReleaseRunnable)
            mainHandler.postDelayed(pttReleaseRunnable, 750)
        }
    }

    private fun wakeScreenOnPtt() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val screenWakeLock = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "cireradio:ptt_screen_wake"
            )
            screenWakeLock.acquire(1500)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun acquireLocks() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "cireradio:lock_service_wakelock"
            ).apply {
                setReferenceCounted(false)
                acquire(24 * 60 * 60 * 1000L)
            }

            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wifiManager.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                "cireradio:lock_wifi_wakelock"
            ).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Servicio de Radio CIRE UNAH",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Mantiene la radio abierta y escuchando transmisiones de voz"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(channelName: String, isTx: Boolean): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        val stopIntent = Intent(this, WalkieTalkieService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        val title = if (isTx) "🔴 TRANSMITIENDO EN VIVO" else "🟢 CIRE RADIO - ACTIVO"
        val text = "Canal: $channelName | Pulsa Vol- para hablar con pantalla apagada"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Salir de Radio", stopPendingIntent)
            .build()
    }

    private fun updateNotificationTransmitting(isTx: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(currentActiveChannelName, isTx))
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(pttReleaseRunnable)
        try {
            mediaSession?.isActive = false
            mediaSession?.release()
            mediaSession = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (e: Exception) {
            e.printStackTrace()
        }
        super.onDestroy()
    }
}
