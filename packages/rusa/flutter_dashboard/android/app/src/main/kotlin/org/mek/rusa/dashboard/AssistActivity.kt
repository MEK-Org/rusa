package org.mek.rusa.dashboard

import android.content.Intent
import android.app.KeyguardManager
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * The assist screen. Handles the trigger's action: ACTION_ASSIST for the assist
 * gesture, and ACTION_VOICE_COMMAND for a headset's assistant button (HFP
 * AT+BVRA). It runs the `assistMain` Dart entrypoint, which opens walkie
 * recording to root over the lock screen without requiring an unlock. A trigger
 * while it is open reaches Dart as `trigger` and stops and sends. Leaving the
 * screen stops capture and playback but retains a returnable conversation.
 */
class AssistActivity : FlutterActivity() {
    private var assistant: AssistantChannel? = null
    private var backgrounded = false
    private var pendingReply: Pair<String, String>? = null

    override fun getDartEntrypointFunctionName(): String = "assistMain"

    override fun getInitialRoute(): String? {
        val reply = replyTarget(intent) ?: return super.getInitialRoute()
        if (isDeviceLocked()) {
            pendingReply = reply
            // Do not hand reply identifiers to Dart until the keyguard has
            // been dismissed. The page waits without starting microphone
            // capture, then receives the target through the channel.
            return Uri.Builder().path("reply-pending").build().toString()
        }
        return Uri.Builder()
            .path("reply")
            .appendQueryParameter("actorId", reply.first)
            .appendQueryParameter("announcementId", reply.second)
            .build()
            .toString()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = AssistantChannel(
            this,
            flutterEngine.dartExecutor.binaryMessenger,
            withHeadset = true,
        )
        assistant = channel
        answerHeadset(intent, channel)
        pendingReply?.let { deferReplyUntilUnlocked(channel, it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val channel = assistant ?: return
        val reply = replyTarget(intent)
        if (reply != null) {
            deferReplyUntilUnlocked(channel, reply)
            return
        }
        // An ordinary assist trigger retains the previously approved locked
        // walkie surface. A reply notification never changes that policy.
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        if (backgrounded) {
            backgrounded = false
            channel.foreground()
        }
        answerHeadset(intent, channel)
        channel.trigger()
    }

    /**
     * A stopped task remains returnable. Dart cancels an active capture and
     * suspends automatic playback, but keeps its authenticated voice session
     * and reply transcript until the user explicitly exits or Android destroys
     * the task.
     */
    override fun onStop() {
        super.onStop()
        if (isChangingConfigurations || backgrounded) return
        backgrounded = true
        assistant?.background()
    }

    override fun onStart() {
        super.onStart()
        if (!backgrounded || pendingReply != null) return
        backgrounded = false
        assistant?.foreground()
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

    private fun replyTarget(intent: Intent?): Pair<String, String>? {
        if (intent?.action != REPLY_ACTION) return null
        val actorId = intent.getStringExtra("actorId")?.takeIf { it.isNotBlank() } ?: return null
        val announcementId = intent.getStringExtra("announcementId")?.takeIf { it.isNotBlank() }
            ?: return null
        return actorId to announcementId
    }

    private fun deferReplyUntilUnlocked(channel: AssistantChannel, reply: Pair<String, String>) {
        if (!isDeviceLocked()) {
            pendingReply = null
            channel.reply(reply.first, reply.second)
            return
        }
        pendingReply = reply
        // Keep a generic system notification on the lock screen, but never
        // show its old conversation or play audio until device authentication.
        setShowWhenLocked(false)
        setTurnScreenOn(false)
        window.decorView.post {
            val keyguard = getSystemService(KeyguardManager::class.java) ?: return@post
            keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() {
                    val target = pendingReply ?: return
                    pendingReply = null
                    channel.reply(target.first, target.second)
                }
            })
        }
    }

    private fun isDeviceLocked(): Boolean =
        getSystemService(KeyguardManager::class.java)?.isDeviceLocked == true

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        assistant?.dispose()
        assistant = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    companion object {
        const val REPLY_ACTION = "org.mek.rusa.dashboard.OPEN_REPLY"
    }
}
