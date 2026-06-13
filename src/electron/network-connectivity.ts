import os from 'os';

// Interface name prefixes that are virtual / container / VM / VPN / link-local-only
// and therefore do NOT indicate a real internet path. They're filtered out so the
// connectivity check isn't fooled by an always-up bridge
const VIRTUAL_INTERFACE_PREFIXES = [
  // Linux: bridges, containers, VMs, VPNs
  'virbr', 'docker', 'br-', 'veth', 'vnet', 'vmnet', 'vboxnet',
  'tun', 'tap', 'wg', 'lxc', 'lxd', 'kube', 'cni', 'flannel', 'weave',
  'zt', 'ham', 'tailscale',
  // macOS: link-local-only / VPN / internal
  'awdl', 'llw', 'utun', 'bridge', 'gif', 'stf', 'anpi', 'ap',
];

function isVirtualInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// Returns true if the machine has at least one real network interface up
export function isNetworkConnected(): boolean {
  const interfaces = os.networkInterfaces();

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!addresses || isVirtualInterface(name)) {
      continue;
    }

    for (const addr of addresses) {
      if (addr.internal) {
        continue;
      }
      // Link-local addresses mean an interface is up but has no real connectivity.
      if (addr.family === 'IPv4' && addr.address.startsWith('169.254.')) {
        continue;
      }
      if (addr.family === 'IPv6' && addr.address.toLowerCase().startsWith('fe80')) {
        continue;
      }
      return true;
    }
  }

  return false;
}
