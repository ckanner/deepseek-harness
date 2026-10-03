import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { PI_AI_DEVICE_ID_FILE_NAME, getOrCreateDeviceId, resetDeviceIdCache } from '../src/device-id.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dirs: string[] = []

/** A context whose launch environment names one harness home. */
function contextFor(dshHome: string): Context {
  const ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DSH_HOME: dshHome } },
  ]))
  return ctx
}

/** A fresh harness home, registered for cleanup. */
async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-device-id-'))
  dirs.push(dir)
  return dir
}

/** Read the id file a sign-in would have created. */
function idFile(dshHome: string): string {
  return join(dshHome, PI_AI_DEVICE_ID_FILE_NAME)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('pi-ai installation host id', () => {
  it('mints a UUID on first use and persists it as a bare line', async () => {
    const dshHome = await home()
    const ctx = contextFor(dshHome)

    const id = getOrCreateDeviceId(ctx)

    expect(id).toMatch(UUID_PATTERN)
    await expect(readFile(idFile(dshHome), 'utf8')).resolves.toBe(`${id}\n`)
  })

  it('answers the same id on every later call, from disk as well as memo', async () => {
    const dshHome = await home()
    const first = getOrCreateDeviceId(contextFor(dshHome))

    // Same process, fresh context: the memo answers without another read.
    expect(getOrCreateDeviceId(contextFor(dshHome))).toBe(first)

    // A later launch has no memo, so the persisted value is what must hold.
    const reloaded = contextFor(dshHome)
    resetDeviceIdCache(reloaded)
    expect(getOrCreateDeviceId(reloaded)).toBe(first)
  })

  it('keeps one home per installation: two homes never share an id', async () => {
    const first = getOrCreateDeviceId(contextFor(await home()))
    const second = getOrCreateDeviceId(contextFor(await home()))

    expect(second).not.toBe(first)
  })

  it('replaces a corrupt file instead of failing the sign-in that needs it', async () => {
    const dshHome = await home()
    await writeFile(idFile(dshHome), 'not-a-uuid\n', 'utf8')

    const id = getOrCreateDeviceId(contextFor(dshHome))

    expect(id).toMatch(UUID_PATTERN)
    await expect(readFile(idFile(dshHome), 'utf8')).resolves.toBe(`${id}\n`)
  })

  it('still answers an id when the home cannot be written', async () => {
    const dshHome = await home()
    // A directory where the id file belongs makes every write fail, which is
    // the read-only-home case a sign-in must survive.
    await mkdir(idFile(dshHome), { recursive: true })
    const ctx = contextFor(dshHome)

    expect(getOrCreateDeviceId(ctx)).toMatch(UUID_PATTERN)
  })
})
