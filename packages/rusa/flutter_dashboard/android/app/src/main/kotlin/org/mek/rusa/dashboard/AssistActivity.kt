package org.mek.rusa.dashboard

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * The assist screen. [AssistGateActivity] starts it on an unlocked phone with
 * the trigger's action: ACTION_ASSIST for the assist gesture, and
 * ACTION_VOICE_COMMAND for a headset's assistant button (HFP AT+BVRA). It runs
 * the `assistMain` Dart entrypoint, which opens walkie recording to root. A
 * trigger while it is open reaches Dart as `trigger` and stops and sends. It
 * never shows over the keyguard, and the session ends once it leaves the screen.
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
     * Leaving the screen ends the session: locking, screen off, Home or another
     * app. A stopped activity gets no later callback when the phone then locks,
     * so finishing here is what keeps nothing recording or playing behind the
     * keyguard. Finishing destroys this activity's engine, and the record and
     * audioplayers plugins release their recorders and players on detach.
     */
    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) finish()
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
