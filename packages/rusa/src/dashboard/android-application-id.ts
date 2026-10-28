/**
 * The Android application id (#1191): the package an installed dashboard APK
 * is known by on the device, in Firebase and to every sideload after it. It is
 * derived from the root handle only; there is deliberately no config override.
 */

/** The id every build used before #1191; still the id of an unbranded build. */
export const LEGACY_ANDROID_APPLICATION_ID = "org.mek.rusa.dashboard";

// Java reserved words and literals: a segment named after one cannot be a Java
// package, and `applicationId` doubles as the manifest's package.
const JAVA_RESERVED = new Set(
  (
    "abstract assert boolean break byte case catch char class const continue default do double " +
    "else enum extends false final finally float for goto if implements import instanceof int " +
    "interface long native new null package private protected public return short static strictfp " +
    "super switch synchronized this throw throws transient true try void volatile while"
  ).split(" ")
);

/**
 * Why `id` is not a legal Android application id, or null when it is.
 *
 * Android's rule: at least two dot-separated segments, each starting with a
 * letter and containing only ASCII letters, digits and underscores.
 */
export function androidApplicationIdProblem(id: string): string | null {
  const segments = id.split(".");
  if (segments.length < 2) return "needs at least two dot-separated segments";
  for (const segment of segments) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(segment)) {
      return `segment "${segment}" must start with a letter and contain only letters, digits and underscores`;
    }
    if (JAVA_RESERVED.has(segment)) return `segment "${segment}" is a Java reserved word`;
  }
  return null;
}

/**
 * The id for a root handle: `com.<handle>.dashboard` with every character
 * outside `[A-Za-z0-9_]` stripped, so `silicon-familiar` →
 * `com.siliconfamiliar.dashboard`. Throws, naming the handle and the reason,
 * when what remains is not a legal id: the build fails rather than guessing.
 */
export function deriveAndroidApplicationId(handle: string): string {
  const id = `com.${handle.replace(/[^A-Za-z0-9_]/g, "")}.dashboard`;
  const problem = androidApplicationIdProblem(id);
  if (problem) {
    throw new Error(
      `rootActor.handle "${handle}" does not yield a legal Android application id (${id}): ${problem}`
    );
  }
  return id;
}
