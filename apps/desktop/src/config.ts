/**
 * Product constants shared by the desktop host and its runtime updater.
 * Release compatibility is explicit: a runtime declares the minimum desktop
 * version and exact protocol version it requires.
 */

/** GitHub repository that publishes reviewed Harness runtime releases. */
export const RUNTIME_RELEASE_REPOSITORY = 'shijiejintoulwh/deepseek-harness'

/** Prefix separating Harness runtime releases from desktop installer releases. */
export const RUNTIME_RELEASE_TAG_PREFIX = 'runtime-v'

/** GitHub repository that publishes reviewed desktop shell releases. */
export const DESKTOP_RELEASE_REPOSITORY = 'shijiejintoulwh/deepseek-harness'

/** Prefix separating desktop installer releases from other repository releases. */
export const DESKTOP_RELEASE_TAG_PREFIX = 'desktop-v'

/** Update protocol implemented by this desktop host. */
export const DESKTOP_PROTOCOL_VERSION = 1

/** Number of failed candidate launches that rejects a pending runtime. */
export const MAX_PENDING_LAUNCH_FAILURES = 2

/** Time a new runtime must remain alive after the page loads before activation. */
export const PENDING_RUNTIME_STABILITY_MS = 30_000

/** Timeout for the Harness process to announce and serve its loopback URL. */
export const RUNTIME_START_TIMEOUT_MS = 30_000

/**
 * Ed25519 public key for signed runtime manifests. The private key is generated
 * into the ignored `.desktop-local` directory and moves to the protected GitHub
 * release environment before publication.
 */
export const RUNTIME_MANIFEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAIWLIQuMcNKNYTLaEC6cKhctUebll+Vf3YTMyAT13uV0=
-----END PUBLIC KEY-----
`

/**
 * Ed25519 public key dedicated to desktop update manifests. Its private key
 * remains outside the repository in the protected desktop-release environment.
 */
export const DESKTOP_UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgZawE9R9NoQ76IpMGoBNsZcKcbQ55zGsAn9XLvhOluM=
-----END PUBLIC KEY-----
`
