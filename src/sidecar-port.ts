/**
 * Dual-stack sidecar port selection.
 *
 * A devframe hub's `ws.port` binds only the loopback family it is given
 * (`host`, typically `127.0.0.1`). When a browser page dials the advertised
 * port on an ambiguous hostname (e.g. `ws://localhost:<port>`), DNS can
 * resolve to the *other* loopback family — `::1` — and reach an unrelated
 * hub that happens to already own that port number there. Picking a port
 * that is free on every loopback family in range closes that hole: no other
 * hub can be sitting on the same port number on either family.
 */
import * as net from 'node:net'

const DEFAULT_PORT_RANGE: [number, number] = [9777, 9877]
const DEFAULT_HOSTS = ['127.0.0.1', '::1']

export interface ResolveDualStackSidecarPortOptions {
  /** Inclusive port range to probe. @default [9777, 9877] */
  portRange?: [number, number]
  /** Loopback addresses that must all be free before a port is accepted. @default ['127.0.0.1', '::1'] */
  hosts?: string[]
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Whether `port` is free on `host`. A bind failure naming the address
 * itself as unreachable (`EADDRNOTAVAIL`, a family the machine doesn't
 * support at all — no IPv6 configured — or `EAFNOSUPPORT`) means that
 * family can never be occupied here, so it is treated as free rather than
 * blocking every port in range.
 */
function isFreeOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') {
        resolve(true)
        return
      }
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    try {
      server.listen(port, host)
    } catch (error) {
      if (
        isErrnoException(error) &&
        (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')
      ) {
        resolve(true)
        return
      }
      resolve(false)
    }
  })
}

async function isFreeOnAllHosts(port: number, hosts: string[]): Promise<boolean> {
  for (const host of hosts) {
    if (!(await isFreeOnHost(port, host))) return false
  }
  return true
}

/**
 * Finds the first port in `portRange` that is free on every host in
 * `hosts` — by default both loopback families, `127.0.0.1` and `::1`.
 */
export async function resolveDualStackSidecarPort(
  options: ResolveDualStackSidecarPortOptions = {},
): Promise<number> {
  const [start, end] = options.portRange ?? DEFAULT_PORT_RANGE
  const hosts = options.hosts ?? DEFAULT_HOSTS
  for (let port = start; port <= end; port++) {
    if (await isFreeOnAllHosts(port, hosts)) return port
  }
  throw new Error(
    `[component-highlighter] No free sidecar port in ${start}-${end} on ${hosts.join(', ')}.`,
  )
}
