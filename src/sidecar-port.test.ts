import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDualStackSidecarPort } from './sidecar-port'

/** A documentation-only address (RFC 5737 TEST-NET-3) no local interface ever owns, standing in for a loopback family the machine has no support for at all — binding to it fails the same way (`EADDRNOTAVAIL`) as binding to `::1` on a box with IPv6 disabled. */
const UNASSIGNED_HOST = '203.0.113.1'

const servers: net.Server[] = []

function listenOn(port: number, host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.once('listening', () => {
      servers.push(server)
      resolve(server)
    })
    server.listen(port, host)
  })
}

/** True when this machine can actually bind IPv6 loopback — some CI/sandboxes cannot. */
async function supportsIpv6Loopback(): Promise<boolean> {
  try {
    const server = await listenOn(0, '::1')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    servers.splice(servers.indexOf(server), 1)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('resolveDualStackSidecarPort', () => {
  it('returns a free port when nothing in range is occupied', async () => {
    const port = await resolveDualStackSidecarPort({
      portRange: [19801, 19803],
      hosts: ['127.0.0.1', '::1'],
    })
    expect(port).toBe(19801)
  })

  it('skips a port occupied only on 127.0.0.1', async () => {
    await listenOn(19811, '127.0.0.1')
    const port = await resolveDualStackSidecarPort({
      portRange: [19811, 19813],
      hosts: ['127.0.0.1', '::1'],
    })
    expect(port).toBe(19812)
  })

  it('skips a port occupied only on ::1', async ({ skip }) => {
    if (!(await supportsIpv6Loopback())) {
      skip()
      return
    }
    await listenOn(19821, '::1')
    const port = await resolveDualStackSidecarPort({
      portRange: [19821, 19823],
      hosts: ['127.0.0.1', '::1'],
    })
    expect(port).toBe(19822)
  })

  it('treats a family the machine has no support for as free', async () => {
    // UNASSIGNED_HOST can never be bound on this machine (no interface owns
    // it), the same failure shape (EADDRNOTAVAIL) as an IPv6-less machine
    // trying to bind `::1` — the probe must not block every port over it.
    const port = await resolveDualStackSidecarPort({
      portRange: [19831, 19831],
      hosts: ['127.0.0.1', UNASSIGNED_HOST],
    })
    expect(port).toBe(19831)
  })

  it('throws when no port in range is free on every host', async () => {
    await listenOn(19841, '127.0.0.1')
    await expect(
      resolveDualStackSidecarPort({
        portRange: [19841, 19841],
        hosts: ['127.0.0.1', '::1'],
      }),
    ).rejects.toThrow(/No free sidecar port/)
  })
})
