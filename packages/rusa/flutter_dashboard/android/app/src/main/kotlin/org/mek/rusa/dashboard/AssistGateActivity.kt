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
 */
class AssistGateActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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

    /**
     * Hands the trigger to the assist screen: a new one starts recording, an
     * open one gets it through onNewIntent and stops and sends.
     */
    private fun openAssistant() {
        startActivity(Intent(this, AssistActivity::class.java).setAction(intent.action))
        finish()
    }
}
