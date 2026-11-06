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
    private var restoringFromRecents = false

    override fun getDartEntrypointFunctionName(): String = "assistMain"

    override fun getInitialRoute(): String? {
        if (isRestoringFromRecents(intent)) {
            restoringFromRecents = true
            // A process-recreated task must not interpret its historical
            // launch as a fresh assist gesture or stale notification tap.
            return Uri.Builder().path("recents").build().toString()
        }
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
            restoringFromRecents = false
            deferReplyUntilUnlocked(channel, reply)
            return
        }
        if (isRestoringFromRecents(intent)) {
            // Restoring the task may render the retained screen, but it must
            // not make an old capture or queued reply audible, nor treat the
            // historical launch as a new assistant gesture.
            restoringFromRecents = true
            return
        }
        // An ordinary assist trigger retains the previously approved locked
        // walkie surface. A reply notification never changes that policy.
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        restoringFromRecents = false
        if (isDeviceLocked()) {
            if (backgrounded) {
                // A lock-screen gesture after a retained, unlocked session
                // starts a new restricted capture. Never surface that old
                // chat or queued audio over the keyguard first.
                backgrounded = false
                channel.lockedAssist()
            } else {
                // The initial locked capture is already restricted; a second
                // gesture keeps its existing stop-and-send contract.
                channel.trigger()
            }
            answerHeadset(intent, channel)
            return
        }
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
        if (isDeviceLocked()) {
            // A retained unlocked task must not render its transcript over the
            // keyguard merely because Android starts it again. A later locked
            // assist gesture explicitly re-enables this restricted surface and
            // requests a fresh capture through onNewIntent().
            setShowWhenLocked(false)
            setTurnScreenOn(false)
            return
        }
        backgrounded = false
        restoringFromRecents = false
        // Dart restores visibility while retaining the playback suspension;
        // only an explicit reply interaction can resume queued audio.
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

    private fun isRestoringFromRecents(intent: Intent?): Boolean =
        intent?.flags?.and(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0

    private fun deferReplyUntilUnlocked(channel: AssistantChannel, reply: Pair<String, String>) {
        if (!isDeviceLocked()) {
            pendingReply = null
            deliverReply(channel, reply)
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
                    deliverReply(channel, target)
                }

                override fun onDismissCancelled() {
                    // A cancelled keyguard request has no safe reply handoff.
                    // Do not reveal a retained session or start capture from a
                    // notification route that never reached post-unlock Dart.
                    pendingReply = null
                    finish()
                }

                override fun onDismissError() {
                    pendingReply = null
                    finish()
                }
            })
        }
    }

    private fun deliverReply(channel: AssistantChannel, reply: Pair<String, String>) {
        // This task is visible for the notification handoff. Mark it foreground
        // before Dart suspends its old queue and resolves the one selected reply,
        // so a later onStop() cannot accidentally skip the background boundary.
        backgrounded = false
        channel.reply(reply.first, reply.second)
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
