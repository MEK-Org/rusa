# Dashboard authentication

Rusa optionally admits one Google account to the dashboard. That account acts
as `human:operator`, with the same authority as the existing local operator.
This slice creates no users, migrates no historical identities, and retains one
root actor. Omit `auth` to keep the existing unauthenticated local mode.

```yaml
auth:
  email: owner@example.com
  firebase:
    projectId: example-project
    apiKey: YOUR_FIREBASE_WEB_API_KEY
    authDomain: example-project.firebaseapp.com
    serviceAccountKeyPath: /absolute/path/to/firebase-admin.json
```

Enable Google in the Firebase project's Authentication sign-in providers and
add the dashboard hostname to its authorized domains. Use a service account
from that same project with permission to manage Firebase Authentication.
The Web API key, project ID, and auth domain are public client configuration;
the email policy and service-account file are never served to the browser.
The Firebase SDK is bundled with the dashboard; no additional script CDN is
required. Rebuild the dashboard and restart Rusa after changing configuration.
Both `rusa start` and the standalone `rusa dashboard` honor this configuration.

Serve the dashboard over HTTPS, for example through Tailscale Serve. A reverse
proxy must preserve the original `Host` header. The session cookie always uses
`Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`, with the `__Host-` prefix.
State-changing requests require a matching browser `Origin`; requests with a
missing or foreign origin are rejected, including login and logout. HTTP
localhost is accepted for development where the browser supports Secure
localhost cookies. Firebase Auth emulator configuration is rejected by the
production authentication boundary.

The login screen offers Google sign-in only. The server verifies Firebase ID
tokens, verified email, Google as the sign-in provider, and the configured
email before issuing a Firebase session cookie. There is no Rusa registration
or invitation flow. Firebase may create its own provider account during Google
sign-in; that does not grant access to Rusa.

## Visits, inactivity, and logout

The cookie expires five days after the last successful visit/navigation
renewal. Returning to a visible browser tab also counts as a visit. Polling,
Firebase's automatic ID-token refresh, and SSE heartbeats do not renew it.
An hour without navigation or a return to the tab pauses both mesh and voice
streams. The next navigation/visit renews the session and reconnects them.
Mouse movement and scrolling do not count as navigation.

To support renewal without another Google prompt, Firebase retains its refresh
credential in browser storage. Rusa's cookie remains HttpOnly. Renewal requires
both a valid existing Rusa cookie and a freshly verified Firebase ID token for
the same subject. A retained Firebase credential cannot revive a Rusa session
that has expired after five idle days: the user must sign in again. Initial
session creation requires a Google authentication within the last five minutes.

Open the profile avatar in the dashboard's upper-right corner and choose **Log out**.
The avatar uses your Firebase profile photo, with a person-icon fallback.
Logout clears the Rusa cookie and signs out
Firebase across tabs on this browser. It does not revoke other devices' sessions.
Use Firebase's user disablement or refresh-token revocation to end all sessions;
requests and open streams observe revocation within 60 seconds. Signature and
expiry checks still run on every request. Configuration changes apply at restart.

All dashboard data, mutations, avatars, quota/understanding views, voice, and SSE
are behind the same gate. Public routes are the generic login shell and bundled
login script, health, client auth configuration, and login/session endpoints.
GitHub webhook HMAC, host wake tokens, and actor MCP endpoints retain their
separate machine authentication; Firebase does not authorize them.

CLI commands that consume dashboard HTTP endpoints (`rusa chat`, `rusa logs`)
do not currently perform Firebase login and therefore cannot use an authenticated
dashboard. Local database tools and actor MCP communication are unaffected.

Firebase references: [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin),
[session cookies](https://firebase.google.com/docs/auth/admin/manage-cookies).

## Verification

Run the focused server/config/browser-controller suite with:

```sh
pnpm --filter rusa exec vitest run src/dashboard/auth.test.ts src/dashboard/auth-browser.test.ts src/config/dashboard-auth.test.ts
```

The built-asset smoke test uses Chromium, with no real Firebase account:

```sh
pnpm --filter rusa run build:dashboard-ui
pnpm --filter rusa exec playwright install chromium
RUSA_AUTH_BROWSER_SMOKE=1 pnpm --filter rusa exec vitest run src/dashboard/auth.browser.integration.test.ts
```

Before deployment, exercise Google sign-in against the configured project over
HTTPS, verify rejection of another account, and check logout and Firebase
revocation. Unit tests inject the Firebase verifier; the emulator test below
uses the real Firebase SDKs but does not perform a real Google OAuth exchange.

## Disposable instance with Firebase Auth emulator

No Firebase project, service account, or real Google account is needed. In one
terminal, from the repository root:

```sh
pnpm dlx firebase-tools@15.30.0 emulators:start --only auth --project demo-rusa-auth --config packages/rusa/firebase.e2e.json
```

In another terminal:

```sh
pnpm e2e am-up --root-driver external --port-offset 100 --base-config-home /nonexistent-rusa-auth-e2e-config --auth-emulator 127.0.0.1:9099 --auth-email operator@example.com
```

Open <http://127.0.0.1:8183>, click **Sign in with Google**, then **Add new
account** in the emulator popup. Enter `operator@example.com`; no password is
needed. Other email addresses are denied by Rusa. The emulator user-management
UI is at <http://127.0.0.1:4001/auth>. Use `127.0.0.1` consistently, not `localhost`:
mixing the two can prevent the emulator popup from communicating with its iframe.
These services bind to loopback; when using
a remote development machine, forward ports 8183, 9099, and optionally 4001 to
the same ports on your browser's machine.

The external root does not launch a model run. The deliberately nonexistent
base config avoids copying real provider or Gemini credentials. The emulator
option exists only on the disposable e2e launcher; normal production startup
still rejects `FIREBASE_AUTH_EMULATOR_HOST`.

With both services running and Chromium installed, verify popup login, rejection
of another email, protected data, navigation renewal, and logout:

```sh
RUSA_AUTH_EMULATOR_E2E=http://127.0.0.1:8183 pnpm --filter rusa exec vitest run src/e2e/auth-emulator.browser.test.ts src/e2e/auth-emulator.test.ts
```

Ctrl-C stops each service. The e2e instance root printed at startup is retained;
`pnpm e2e am-down --root <printed-root>` stops it and removes its disposable data.
Emulator users are in memory and disappear when the emulator stops.

See Firebase's [Auth emulator documentation](https://firebase.google.com/docs/emulator-suite/connect_auth)
for the simulated provider popup and unsigned emulator session cookies.
