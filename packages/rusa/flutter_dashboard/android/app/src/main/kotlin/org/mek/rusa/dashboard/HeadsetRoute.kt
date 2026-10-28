package org.mek.rusa.dashboard

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi

/**
 * The Bluetooth headset microphone for one walkie recording. [acquire] starts
 * the headset's voice recognition (HFP +BVRA, which opens its SCO voice link)
 * and routes communication audio to it: `setCommunicationDevice` on API 31+,
 * `startBluetoothSco` before. [onLost] fires when a routed link goes away, as
 * when the headset's button ends voice recognition. Main thread only.
 */
class HeadsetRoute(private val context: Context, private val onLost: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(AudioManager::class.java)
    private val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter

    private var proxy: BluetoothHeadset? = null
    private var proxyRequested = false
    private var closed = false

    /** Voice recognition was asked for before the profile proxy connected. */
    private var wantRecognition = false
    private var recognitionDevice: BluetoothDevice? = null

    private var savedMode: Int? = null
    private var communicationSet = false
    private var scoStarted = false
    private var routed = false
    private var pending: ((Boolean) -> Unit)? = null
    private val timeout = Runnable { settle(false) }
    private var communicationListener: Any? = null
    private var scoReceiver: BroadcastReceiver? = null

    private val profileListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, headset: BluetoothProfile) {
            if (closed) {
                adapter?.closeProfileProxy(BluetoothProfile.HEADSET, headset)
                return
            }
            proxy = headset as BluetoothHeadset
            if (wantRecognition) startVoiceRecognition()
        }

        override fun onServiceDisconnected(profile: Int) {
            proxy = null
            recognitionDevice = null
        }
    }

    init {
        // Connect the profile proxy up front: a headset's voice-command request
        // must be answered within its window, and pre-31 routing reads it.
        if (canUseBluetooth()) requestProxy()
    }

    /**
     * Answer (or open) the headset's voice recognition on the first connected
     * headset. Without one, or without BLUETOOTH_CONNECT, it does nothing.
     */
    @SuppressLint("MissingPermission")
    fun startVoiceRecognition() {
        if (closed || !canUseBluetooth()) return
        wantRecognition = true
        val headset = proxy
        if (headset == null) {
            requestProxy()
            return
        }
        wantRecognition = false
        if (recognitionDevice != null) return
        try {
            val device = headset.connectedDevices.firstOrNull() ?: return
            if (headset.startVoiceRecognition(device)) recognitionDevice = device
        } catch (_: SecurityException) {
            // Permission revoked since the check.
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopVoiceRecognition() {
        wantRecognition = false
        val device = recognitionDevice ?: return
        recognitionDevice = null
        try {
            proxy?.stopVoiceRecognition(device)
        } catch (_: SecurityException) {
            // Nothing more to undo.
        }
    }

    private fun requestProxy() {
        if (proxyRequested) return
        proxyRequested = adapter?.getProfileProxy(
            context,
            profileListener,
            BluetoothProfile.HEADSET,
        ) == true
    }

    private fun canUseBluetooth(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    /** Route capture to a headset; [done] gets whether it was routed. */
    fun acquire(done: (Boolean) -> Unit) {
        // A newer acquire supersedes a pending one, but keeps the voice
        // recognition the activity may already have answered.
        val superseded = pending
        pending = null
        main.removeCallbacks(timeout)
        superseded?.invoke(false)
        unroute()
        startVoiceRecognition()
        savedMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        pending = done
        main.postDelayed(timeout, ROUTE_TIMEOUT_MS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            routeCommunicationDevice()
        } else {
            routeSco()
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun routeCommunicationDevice() {
        val device = audio.availableCommunicationDevices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        }
        if (device == null) {
            settle(false)
            return
        }
        val listener = AudioManager.OnCommunicationDeviceChangedListener { current ->
            if (current?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) settle(true) else lost()
        }
        communicationListener = listener
        audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, listener)
        communicationSet = audio.setCommunicationDevice(device)
        if (!communicationSet) {
            settle(false)
        } else if (audio.communicationDevice?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
            settle(true)
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun routeSco() {
        val connected = try {
            proxy?.connectedDevices?.isNotEmpty() == true
        } catch (_: SecurityException) {
            false
        }
        if (!connected || !audio.isBluetoothScoAvailableOffCall) {
            settle(false)
            return
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                // The sticky last state may be a previous session's.
                if (isInitialStickyBroadcast) return
                when (intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)) {
                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> settle(true)
                    AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> lost()
                }
            }
        }
        scoReceiver = receiver
        context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
        audio.startBluetoothSco()
        audio.isBluetoothScoOn = true
        scoStarted = true
    }

    private fun settle(ok: Boolean) {
        val done = pending ?: return
        pending = null
        main.removeCallbacks(timeout)
        routed = ok
        if (!ok) teardown()
        done(ok)
    }

    private fun lost() {
        if (!routed) return
        routed = false
        onLost()
    }

    /** Return audio routing to normal. Safe to call when nothing is held. */
    fun release() {
        settle(false)
        teardown()
    }

    private fun teardown() {
        unroute()
        stopVoiceRecognition()
    }

    @Suppress("DEPRECATION")
    private fun unroute() {
        routed = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (communicationListener as AudioManager.OnCommunicationDeviceChangedListener?)
                ?.let { audio.removeOnCommunicationDeviceChangedListener(it) }
            if (communicationSet) audio.clearCommunicationDevice()
        }
        communicationListener = null
        communicationSet = false
        scoReceiver?.let { context.unregisterReceiver(it) }
        scoReceiver = null
        if (scoStarted) {
            audio.isBluetoothScoOn = false
            audio.stopBluetoothSco()
            scoStarted = false
        }
        savedMode?.let { audio.mode = it }
        savedMode = null
    }

    fun close() {
        release()
        closed = true
        proxy?.let { adapter?.closeProfileProxy(BluetoothProfile.HEADSET, it) }
        proxy = null
    }

    companion object {
        private const val ROUTE_TIMEOUT_MS = 3000L
    }
}
