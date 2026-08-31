import { describe, expect, it, vi } from 'vitest'
import { probeWebShell } from './build-windows-runtime.ts'

describe('Windows runtime Web smoke probe', () => {
  it('exchanges the launch token before checking the authenticated shell', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 303,
        headers: {
          location: '/',
          'set-cookie': 'dsh-auth-test=session-value; Path=/; HttpOnly',
        },
      }))
      .mockResolvedValueOnce(new Response('<script>__DSH_BOOT__</script>', { status: 200 }))

    await expect(probeWebShell(new URL('http://127.0.0.1:50120/?token=launch-token'), request)).resolves.toBe(true)
    expect(request).toHaveBeenNthCalledWith(1, new URL('http://127.0.0.1:50120/?token=launch-token'), { redirect: 'manual' })
    expect(request).toHaveBeenNthCalledWith(2, new URL('http://127.0.0.1:50120/'), {
      headers: { cookie: 'dsh-auth-test=session-value' },
      redirect: 'error',
    })
  })

  it('rejects a launch response without a session cookie', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, {
      status: 303,
      headers: { location: '/' },
    }))

    await expect(probeWebShell(new URL('http://127.0.0.1:50120/?token=launch-token'), request)).resolves.toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
