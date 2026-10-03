/**
 * The stable installation identifier one pi-ai sign-in flow may ask for.
 *
 * OpenAI's "Sign in with ChatGPT" flow registers an *agent host* separately
 * from the OAuth client it issues: `ext_agent_host_id` is the thing that says
 * "the same installation that signed in before". pi-ai therefore accepts a
 * login option — `LoginOptions.getDeviceId` — that the host answers with a
 * UUID of its own, and pi-ai itself renders it as `urn:uuid:<lowercased>`.
 * A host that answers with nothing makes that flow fail before the browser
 * ever opens, which is why this value has to outlive the process: an
 * identifier that changed on every launch would read as a new host each time.
 *
 * The identifier is a random UUID v4 persisted as a bare line inside the
 * harness home resolved by {@link resolveDshHome} (`$DSH_HOME` > `~/.dsh`),
 * never derived from the hostname, a user id, or any other identifying
 * source — the same rule the harness home's anonymous user id follows. It is
 * scoped to the harness home rather than the machine, so two homes on one
 * machine are two installations, and deleting the file mints a fresh one.
 *
 * Reads prefer the launch environment over `process.env` so that a value the
 * launcher resolved (`--env-file`, a project `.env`) is the one consulted,
 * exactly as {@link authContextFrom} resolves ambient provider values.
 *
 * @module dsh-llm-pi-ai/device-id
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/**
 * File inside the harness home storing this installation's pi-ai host id: a
 * bare UUID line, no wrapper format, so the value is readable and replaceable
 * by hand.
 */
export const PI_AI_DEVICE_ID_FILE_NAME = '.pi-ai-host-id'

/**
 * The one spelling pi-ai accepts: a bare UUID. pi-ai rejects anything else —
 * including the `urn:uuid:` form it produces itself — because the host id it
 * sends is a rendering of this value, not the value.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Process-lifetime memo keyed by resolved file path, so distinct homes never share an id. */
const memo = new Map<string, string>()

/**
 * Ambient hooks for locating and generating the id; every field has a default.
 */
export interface PiAiDeviceIdOptions {
  /** UUID generator; defaults to `crypto.randomUUID` (test hook). */
  randomUUID?: () => string
}

/** Read a valid persisted id from the file, or `undefined` when absent/corrupt. */
function readPersistedId(file: string): string | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // Absent or unreadable: the caller mints and persists a fresh id.
    return undefined
  }
  const value = text.trim()
  return UUID_PATTERN.test(value) ? value.toLowerCase() : undefined
}

/**
 * The harness home's file backing this installation's pi-ai host id.
 * @param env - environment consulted for `DSH_HOME`.
 * @returns the absolute path of the id file.
 */
function deviceIdFile(env: Record<string, string | undefined>): string {
  return join(resolveDshHome(undefined, env), PI_AI_DEVICE_ID_FILE_NAME)
}

/**
 * The launch environment's view of the variables path resolution consults,
 * narrowed to the two facts {@link resolveDshHome} reads.
 * @param ctx - the plugin context.
 * @returns a lookup suitable for home resolution.
 */
function homeEnvironment(ctx: Context): Record<string, string | undefined> {
  const environment = launchEnvironmentOf(ctx)
  const dshHome = environment.get('DSH_HOME')?.value
  return dshHome === undefined ? {} : { DSH_HOME: dshHome }
}

/**
 * Return this installation's stable pi-ai host id, creating and persisting one
 * on first use.
 *
 * Persistence is best-effort in the same way the harness home's anonymous user
 * id is: a read-only home still yields a usable id for the current run rather
 * than blocking a sign-in that would otherwise work. A concurrent first launch
 * is settled by an exclusive-create write, and the loser adopts the winner's
 * id.
 * @param ctx - the plugin context carrying the launch environment.
 * @param options - generation seams.
 * @returns the installation's UUID, ready for pi-ai to render as `urn:uuid:`.
 */
export function getOrCreateDeviceId(ctx: Context, options: PiAiDeviceIdOptions = {}): string {
  const file = deviceIdFile(homeEnvironment(ctx))
  const cached = memo.get(file)
  if (cached !== undefined) return cached

  let id = readPersistedId(file)
  if (id === undefined) {
    const created = (options.randomUUID ?? randomUUID)()
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${created}\n`, { encoding: 'utf8', flag: 'wx' })
      id = created
    } catch {
      // A `wx` refusal (EEXIST) covers both a concurrent winner and a
      // pre-existing corrupt file: the reread adopts a valid winner, and an
      // invalid reread falls through to the overwrite path. Non-EEXIST
      // failures (read-only home) land there too, accepted best-effort below.
      id = readPersistedId(file)
      if (id === undefined) {
        try {
          writeFileSync(file, `${created}\n`, 'utf8')
        } catch {
          // The home is not writable: this run keeps the id it minted, and the
          // next launch mints another. A sign-in still works; it just does not
          // read as the same host later.
        }
        id = created
      }
    }
  }
  memo.set(file, id)
  return id
}

/**
 * Forget the memoized id for one harness home. Only tests need this: a real
 * process resolves one home, and its id must stay stable for the process's
 * whole lifetime.
 * @param ctx - the plugin context naming the home to forget.
 */
export function resetDeviceIdCache(ctx: Context): void {
  memo.delete(deviceIdFile(homeEnvironment(ctx)))
}
