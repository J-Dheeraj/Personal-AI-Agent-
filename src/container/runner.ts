import { execFileSync } from 'child_process';
import path from 'path';
import { logger } from '../logger';
import { validateMountPath } from '../security/mountAllowlist';

const GROUPS_DIR = path.join(process.env.HOME || '/root', 'nanoclaw', 'groups');
const ONECLI_PORT = parseInt(process.env.ONECLI_PORT || '4891');
const NETWORK_NAME = 'nanoclaw-net';

export class ContainerRunner {
  private running = new Map<string, string>(); // groupId -> containerId

  private ensureNetworkExists(): void {
    try {
      execFileSync('docker', ['network', 'inspect', NETWORK_NAME], { stdio: 'ignore' });
    } catch {
      logger.info({ network: NETWORK_NAME }, 'Creating Docker bridge network');
      execFileSync('docker', ['network', 'create', NETWORK_NAME]);
    }
  }

  async ensureRunning(groupId: string): Promise<void> {
    if (this.running.has(groupId)) {
      try {
        const containerId = this.running.get(groupId)!;
        const out = execFileSync(
          'docker', ['inspect', '-f', '{{.State.Running}}', containerId],
          { encoding: 'utf8' }
        ).trim();
        if (out === 'true') return;
      } catch {
        this.running.delete(groupId);
      }
    }

    const groupDir = path.join(GROUPS_DIR, groupId);

    if (!validateMountPath(groupDir)) {
      throw new Error(`Mount denied for group directory: ${groupDir}`);
    }

    this.ensureNetworkExists();

    const containerName = `nanoclaw-agent-${groupId}`;

    try {
      execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    } catch { /* container may not exist — that is fine */ }

    const args = [
      'run', '-d',
      '--name', containerName,
      '--network', NETWORK_NAME,
      '--add-host', 'host.docker.internal:host-gateway',
      '--env', `ONECLI_PROXY=http://host.docker.internal:${ONECLI_PORT}`,
      '--env', `GROUP_ID=${groupId}`,
      '--env', `GROUP_DIR=/workspace/group`,
      '--env', `ANTHROPIC_BASE_URL=http://host.docker.internal:${ONECLI_PORT}`,
      '--env', `OLLAMA_HOST=http://host.docker.internal:11434`,
      '-v', `${groupDir}:/workspace/group`,
      'nanoclaw-agent:latest',
    ];

    logger.info({ groupId, containerName }, 'Spawning agent container');
    const containerId = execFileSync('docker', args, { encoding: 'utf8' }).trim();
    this.running.set(groupId, containerId);
    logger.info({ groupId, containerId }, 'Container started');
  }

  getRunningContainers(): Map<string, string> {
    return new Map(this.running);
  }
}
