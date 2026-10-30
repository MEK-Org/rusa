package org.mek.rusa.dashboard

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * The `org.mek.rusa.dashboard/assistant` channel (`assistant_io.dart`): the
 * assistant role's status and settings page, and, [withHeadset], the headset
 * microphone route. Only the assist activity records through a headset.
 */
class AssistantChannel(
    private val activity: Activity,
    messenger: BinaryMessenger,
    withHeadset: Boolean = false,
) : MethodChannel.MethodCallHandler {
    private val channel = MethodChannel(messenger, NAME)
    val headset = if (withHeadset) {
        HeadsetRoute(activity) { channel.invokeMethod("routeLost", null) }
    } else {
        null
    }
    private var pendingSettings: MethodChannel.Result? = null

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "roleStatus" -> result.success(roleStatus())
            "openAssistantSettings" -> openAssistantSettings(result)
            "acquireHeadset" -> headset?.acquire { routed -> result.success(routed) }
                ?: result.success(false)
            "releaseHeadset" -> {
                headset?.release()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    fun trigger() = channel.invokeMethod("trigger", null)

    /** Asks Dart to end the session; [done] runs once it has, or failed to. */
    fun end(done: () -> Unit) = channel.invokeMethod(
        "end",
        null,
        object : MethodChannel.Result {
            override fun success(result: Any?) = done()
            override fun error(code: String, message: String?, details: Any?) = done()
            override fun notImplemented() = done()
        },
    )

    private fun roleStatus(): Map<String, Boolean> {
        val roles = activity.getSystemService(RoleManager::class.java)
        val available = roles?.isRoleAvailable(RoleManager.ROLE_ASSISTANT) == true
        return mapOf(
            "available" to available,
            "held" to (available && roles!!.isRoleHeld(RoleManager.ROLE_ASSISTANT)),
        )
    }

    /**
     * The assistant role is not requestable, so setup is the system page. Ask
     * for the trigger's permissions first, so a trigger can start recording
     * at once instead of opening on a permission prompt.
     */
    private fun openAssistantSettings(result: MethodChannel.Result) {
        val missing = triggerPermissions().filter {
            activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            startSettings()
            result.success(null)
            return
        }
        pendingSettings?.success(null)
        pendingSettings = result
        activity.requestPermissions(missing.toTypedArray(), PERMISSION_REQUEST)
    }

    /** Consumes this channel's permission result; false for anyone else's. */
    fun onRequestPermissionsResult(requestCode: Int): Boolean {
        if (requestCode != PERMISSION_REQUEST) return false
        val result = pendingSettings ?: return true
        pendingSettings = null
        startSettings()
        result.success(null)
        return true
    }

    private fun startSettings() {
        for (action in listOf(
            Settings.ACTION_VOICE_INPUT_SETTINGS,
            Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS,
        )) {
            try {
                activity.startActivity(Intent(action))
                return
            } catch (_: ActivityNotFoundException) {
                // Try the broader page.
            }
        }
    }

    private fun triggerPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            listOf(Manifest.permission.RECORD_AUDIO)
        }

    fun dispose() {
        channel.setMethodCallHandler(null)
        pendingSettings?.success(null)
        pendingSettings = null
        headset?.close()
    }

    companion object {
        const val NAME = "org.mek.rusa.dashboard/assistant"
        private const val PERMISSION_REQUEST = 0x7253
    }
}
