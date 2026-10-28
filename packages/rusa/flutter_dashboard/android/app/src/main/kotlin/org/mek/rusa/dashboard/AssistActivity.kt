package org.mek.rusa.dashboard

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * The assistant role's activity. The assist gesture starts it with ACTION_ASSIST
 * and a headset's assistant button (HFP AT+BVRA) with ACTION_VOICE_COMMAND; it
 * runs the `assistMain` Dart entrypoint, which opens walkie recording to root.
 * A trigger while it is open reaches Dart as `trigger` and stops and sends.
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
     * The Bluetooth stack gives the app 5 s to answer a headset's voice-command
     * request with startVoiceRecognition before it reports failure to the
     * headset, which is less than a cold Flutter start. Answer it natively.
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
