/**
 * Deployment-mode detection for the bootstrap/relay servers.
 *
 * When `KIYEOVO_DEPLOY_MODE` is truthy the servers run with strict, fail-closed
 * semantics intended for containerised / CLI-managed deployments:
 *   - a corrupt or unreadable identity file aborts startup instead of silently
 *     rotating the Peer ID (see {@link PeerIdManager.loadOrCreate});
 *   - a missing or invalid required announce address aborts startup instead of
 *     warning and continuing.
 *
 * When unset (the default) the servers keep their lenient behaviour so that a
 * local `npm run bootstrap` / `npm run relay` and a hand-rolled systemd unit are
 * unaffected. The `kiyeovo-infra` CLI / Compose stack sets this to `1`.
 */

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isDeploymentMode(): boolean {
  const raw = process.env.KIYEOVO_DEPLOY_MODE?.trim().toLowerCase();
  return raw != null && TRUTHY_VALUES.has(raw);
}
