/**
 * Network interface enumeration and bind-selection resolution for the web
 * remote server.
 *
 * Design note: the user's choice of "where do I expose this" is *durable
 * intent*, not a snapshot of the addresses that happened to exist when they
 * clicked save. Addresses are inherently unstable — DHCP renumbering, VPN
 * connect/disconnect, Wi-Fi roaming, dock/undock all change them. So a
 * selection is stored as an interface identity (plus family) and resolved to
 * concrete addresses at bind time, every time.
 *
 * Nothing here branches on a specific vendor or product. Interfaces are
 * classified by *scope* (loopback / private / vpn / public), which is what
 * actually determines the security posture.
 */
import * as os from 'os';
import type {
  InterfaceScope,
  WebRemoteBindSelection,
  WebRemoteInterface,
} from '../../shared/ipc-contract';

export type { InterfaceScope, WebRemoteBindSelection, WebRemoteInterface };

export interface ResolvedBindSelection {
  selection: WebRemoteBindSelection;
  /** Addresses currently available for this selection. Empty = pending. */
  addresses: string[];
  scope: InterfaceScope;
  label: string;
}

const SCOPE_LABELS: Record<InterfaceScope, string> = {
  loopback: 'Loopback',
  private: 'Private LAN',
  vpn: 'VPN / tunnel',
  public: 'Public',
};

/**
 * Interface-name prefixes that conventionally indicate a tunnel device across
 * macOS, Linux and Windows. Used only for labeling and scope classification.
 */
const TUNNEL_NAME_PREFIXES = ['utun', 'tun', 'tap', 'ppp', 'wg', 'ipsec', 'gpd', 'nordlynx', 'zt', 'tailscale'];

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function looksLikeTunnelName(name: string): boolean {
  const lower = name.toLowerCase();
  return TUNNEL_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Classify an address + interface name into a security scope.
 *
 * CGNAT space (100.64.0.0/10) is treated as VPN because that range is only
 * ever reachable through carrier-grade NAT or an overlay network — never a
 * plain LAN. That's a property of the address range, not of any one product.
 */
export function classifyInterfaceScope(name: string, address: string, internal: boolean): InterfaceScope {
  if (internal) return 'loopback';

  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'loopback';
    if (looksLikeTunnelName(name)) return 'vpn';
    if (a === 100 && b >= 64 && b <= 127) return 'vpn';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private';
    return 'public';
  }

  const lower = address.toLowerCase().split('%')[0];
  if (lower === '::1') return 'loopback';
  if (looksLikeTunnelName(name)) return 'vpn';
  if (lower.startsWith('fe80:')) return 'private';
  // Unique local addresses (fc00::/7).
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
  return 'public';
}

export function describeScope(scope: InterfaceScope): string {
  return SCOPE_LABELS[scope];
}

export function listWebRemoteInterfaces(): WebRemoteInterface[] {
  const interfaces = os.networkInterfaces();
  const results: WebRemoteInterface[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = entry.family;
      if (family !== 'IPv4' && family !== 'IPv6') continue;

      const scope = classifyInterfaceScope(name, entry.address, entry.internal);
      results.push({
        name,
        address: entry.address,
        family,
        internal: entry.internal,
        scope,
        label: `${name} (${entry.address}, ${SCOPE_LABELS[scope]})`,
      });
    }
  }

  return results.sort(compareInterfaces);
}

const SCOPE_ORDER: InterfaceScope[] = ['vpn', 'private', 'loopback', 'public'];

function compareInterfaces(a: WebRemoteInterface, b: WebRemoteInterface): number {
  const scopeDelta = SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope);
  if (scopeDelta !== 0) return scopeDelta;
  if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
  return a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
}

export function defaultBindSelections(): WebRemoteBindSelection[] {
  return [{ kind: 'address', address: '127.0.0.1' }];
}

function selectionKey(selection: WebRemoteBindSelection): string {
  switch (selection.kind) {
    case 'interface': return `i:${selection.interfaceName}:${selection.family}`;
    case 'address': return `a:${selection.address}`;
    case 'all': return `*:${selection.family}`;
  }
}

/**
 * Validate the *shape* of persisted selections without discarding entries that
 * merely aren't resolvable right now. An interface that is currently down is
 * pending, not invalid — dropping it here is what destroyed users' saved
 * choices in the previous implementation.
 */
export function normalizeBindSelections(value: unknown): WebRemoteBindSelection[] {
  if (!Array.isArray(value)) return defaultBindSelections();

  const seen = new Set<string>();
  const result: WebRemoteBindSelection[] = [];

  for (const raw of value) {
    const selection = coerceSelection(raw);
    if (!selection) continue;
    const key = selectionKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(selection);
    if (result.length >= 16) break;
  }

  return result.length > 0 ? result : defaultBindSelections();
}

function coerceSelection(raw: unknown): WebRemoteBindSelection | null {
  // Legacy format: a bare address string.
  if (typeof raw === 'string') {
    const address = raw.trim();
    return address ? { kind: 'address', address } : null;
  }
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const family = record.family === 'IPv6' ? 'IPv6' : 'IPv4';

  if (record.kind === 'all') return { kind: 'all', family };
  if (record.kind === 'address') {
    const address = typeof record.address === 'string' ? record.address.trim() : '';
    return address ? { kind: 'address', address } : null;
  }
  if (record.kind === 'interface') {
    const interfaceName = typeof record.interfaceName === 'string' ? record.interfaceName.trim() : '';
    return interfaceName ? { kind: 'interface', interfaceName, family } : null;
  }
  return null;
}

/**
 * Migrate the legacy `webRemoteBindAddresses: string[]` config. Addresses that
 * currently belong to a known interface become durable interface selections;
 * the rest are preserved verbatim as pinned addresses so nothing is lost when
 * the owning interface happens to be down during migration.
 */
export function migrateBindAddresses(
  addresses: unknown,
  interfaces: WebRemoteInterface[] = listWebRemoteInterfaces(),
): WebRemoteBindSelection[] {
  if (!Array.isArray(addresses) || addresses.length === 0) return defaultBindSelections();

  const byAddress = new Map(interfaces.map((iface) => [iface.address, iface]));
  const selections: WebRemoteBindSelection[] = [];

  for (const raw of addresses) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const address = raw.trim();
    const iface = byAddress.get(address);
    // Loopback stays pinned: it is stable by definition and binding "every
    // address on lo0" would needlessly widen exposure.
    if (iface && iface.scope !== 'loopback') {
      selections.push({ kind: 'interface', interfaceName: iface.name, family: iface.family });
    } else {
      selections.push({ kind: 'address', address });
    }
  }

  return normalizeBindSelections(selections);
}

export function resolveBindSelections(
  selections: WebRemoteBindSelection[],
  interfaces: WebRemoteInterface[] = listWebRemoteInterfaces(),
): ResolvedBindSelection[] {
  return selections.map((selection) => {
    if (selection.kind === 'all') {
      const address = selection.family === 'IPv6' ? '::' : '0.0.0.0';
      return {
        selection,
        addresses: [address],
        scope: 'public' as InterfaceScope,
        label: `All ${selection.family} interfaces (${address})`,
      };
    }

    if (selection.kind === 'address') {
      const iface = interfaces.find((entry) => entry.address === selection.address);
      const scope = iface?.scope
        ?? classifyInterfaceScope('', selection.address, selection.address === '127.0.0.1' || selection.address === '::1');
      // Loopback is always available even if os.networkInterfaces() is odd.
      const available = iface !== undefined || scope === 'loopback';
      return {
        selection,
        addresses: available ? [selection.address] : [],
        scope,
        label: iface?.label ?? `${selection.address} (${SCOPE_LABELS[scope]})`,
      };
    }

    const matches = interfaces.filter(
      (entry) => entry.name === selection.interfaceName && entry.family === selection.family,
    );
    const scope = matches[0]?.scope ?? 'private';
    return {
      selection,
      addresses: matches.map((entry) => entry.address),
      scope,
      label: matches.length > 0
        ? `${selection.interfaceName} (${matches.map((m) => m.address).join(', ')}, ${SCOPE_LABELS[scope]})`
        : `${selection.interfaceName} (${selection.family}, not currently available)`,
    };
  });
}

/** Flatten resolved selections to the distinct addresses that should be bound. */
export function resolveBindAddresses(
  selections: WebRemoteBindSelection[],
  interfaces: WebRemoteInterface[] = listWebRemoteInterfaces(),
): string[] {
  const addresses = new Set<string>();
  for (const resolved of resolveBindSelections(selections, interfaces)) {
    for (const address of resolved.addresses) addresses.add(address);
  }
  return [...addresses];
}

/**
 * Stable fingerprint of the current address topology, used to detect when the
 * network has changed underneath us and bindings need reconciling.
 */
export function interfaceFingerprint(interfaces: WebRemoteInterface[] = listWebRemoteInterfaces()): string {
  return interfaces
    .map((iface) => `${iface.name}/${iface.family}/${iface.address}`)
    .sort()
    .join('|');
}
