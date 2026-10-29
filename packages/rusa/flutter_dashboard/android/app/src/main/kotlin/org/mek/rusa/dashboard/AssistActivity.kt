package org.mek.rusa.dashboard

import android.app.KeyguardManager
import android.content.Intent
import android.os.PowerManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * The assist screen. [AssistGateActivity] starts it on an unlocked phone with
 * the trigger's action: ACTION_ASSIST for the assist gesture, and
 * ACTION_VOICE_COMMAND for a headset's assistant button (HFP AT+BVRA). It runs
 * the `assistMain` Dart entrypoint, which opens walkie recording to root. A
 * trigger while it is open reaches Dart as `trigger` and stops and sends. It
 * never shows over the keyguard, and the session ends when the phone locks.
 */
class AssistActivity : FlutterActivity() {
    private var assistant: AssistantChannel? = null

    override fun getDartEntrypointFunctionName(): String = "assistMain"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = AssistantChannel(
            this,
            flutterEngine.dartExecutor.binaryMessenger,
            withHeadset = true,
        )
        assistant = channel
        answerHeadset(intent, channel)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val channel = assistant ?: return
        answerHeadset(intent, channel)
        channel.trigger()
    }

    /**
     * Turning the screen off or locking the phone ends the session, so nothing
     * keeps recording or playing behind the keyguard.
     */
    override fun onStop() {
        super.onStop()
        if (isChangingConfigurations) return
        val locked = getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true
        val screenOff = getSystemService(PowerManager::class.java)?.isInteractive == false
        if (locked || screenOff) finish()
    }

    /**
     * The Bluetooth stack gives the app 5 s to answer a headset's voice-command
     * request with startVoiceRecognition before it reports failure to the
     * headset, which is less than a cold Flutter start. Answer it natively.
     * On a locked phone the unlock prompt comes first and can outlast that
     * window, so the headset may report failure before this answer arrives.
     */
    private fun answerHeadset(intent: Intent?, channel: AssistantChannel) {
        if (intent?.action == Intent.ACTION_VOICE_COMMAND) {
            channel.headset?.startVoiceRecognition()
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        assistant?.dispose()
        assistant = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        if (assistant?.onRequestPermissionsResult(requestCode) == true) return
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
}
