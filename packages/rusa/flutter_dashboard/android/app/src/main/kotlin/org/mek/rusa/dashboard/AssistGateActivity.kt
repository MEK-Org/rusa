package org.mek.rusa.dashboard

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle

/**
 * The assistant role's entry point for the assist gesture (ACTION_ASSIST) and
 * a headset's assistant button (ACTION_VOICE_COMMAND). The assistant needs an
 * unlocked phone: on a locked one this draws nothing over the keyguard but
 * the system's unlock prompt, and opens [AssistActivity] only once the user
 * has unlocked. Cancelling the prompt opens nothing.
 *
 * One gate serves one trigger. A trigger while the unlock prompt is up reaches
 * this gate as onNewIntent (singleTop) and opens nothing more. Configuration
 * changes don't recreate it, and a gate restored from saved state finishes.
 *
 * Leaving the screen with the prompt still up, as when the screen turns off,
 * finishes it. SystemUI reports a cancel only for a prompt that is fully
 * showing when it hides, so one hidden mid-animation leaves this request
 * pending, and a later unrelated unlock would report it as succeeded.
 * A finishing gate opens nothing: KeyguardManager checks for destruction
 * only before posting the callback, so one queued while the gate was live
 * can still arrive after this finish.
 */
class AssistGateActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return finish()
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (keyguard?.isKeyguardLocked != true) {
            openAssistant()
            return
        }
        keyguard.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = openAssistant()
                override fun onDismissCancelled() = finish()
                override fun onDismissError() = finish()
            },
        )
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) finish()
    }

    /**
     * Hands the trigger to the assist screen: a new one starts recording, an
     * open one gets it through onNewIntent and stops and sends.
     */
    private fun openAssistant() {
        if (isFinishing || isDestroyed) return
        startActivity(Intent(this, AssistActivity::class.java).setAction(intent.action))
        finish()
    }
}
