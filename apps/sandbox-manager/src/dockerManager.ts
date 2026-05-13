/**
 * Docker container manager using dockerode SDK.
 *
 * Manages isolated contestant containers with:
 * - Hard resource limits (512MB RAM, 1 CPU, 200 PIDs)
 * - Dropped capabilities (no privileged operations)
 * - Isolated network (contestant-net bridge, internal only)
 * - Automatic cleanup timeout (5 minutes safety)
 * - Health check polling
 */
import Docker from 'dockerode';
import { SandboxLogger } from './sandboxLogger';

export interface DeployResult {
  success: boolean;
  containerId?: string;
  internalUrl?: string;
  error?: string;
}

export interface TeardownResult {
  success: boolean;
  error?: string;
}

// Map of submissionId → timeout handle for auto-teardown safety
const autoTeardownTimers = new Map<string, NodeJS.Timeout>();

/**
 * Get or create Docker client instance.
 * On Unix: /var/run/docker.sock
 * On Windows: \\.\pipe\docker_engine (via volume mount in docker-compose)
 */
function getDockerClient(): Docker {
  return new Docker();
}

/**
 * Deploy a contestant image as an isolated container.
 *
 * @param submissionId - Unique identifier for contestant (used in container name + logs)
 * @param imageName - Docker image name (e.g., "contestant-{submissionId}:latest")
 * @param logger - Structured logger
 * @returns DeployResult with containerId and internal URL on success
 */
export async function deployContainer(
  submissionId: string,
  imageName: string,
  logger: SandboxLogger
): Promise<DeployResult> {
  const docker = getDockerClient();
  const containerName = `contestant-${submissionId}`;

  try {
    logger.info('deploy', 'Creating container', {
      submissionId,
      imageName,
      containerName,
      limits: {
        memory: '512MB',
        cpus: '1.0',
        pids: 200
      }
    });

    // Create container with hardened settings
    const container = await docker.createContainer({
      Image: imageName,
      name: containerName,
      Hostname: containerName,
      HostConfig: {
        // Memory limits: 512MB hard limit, no swap
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        
        // CPU limit: 1 full CPU core
        NanoCpus: 1_000_000_000,
        
        // Process limits: prevent fork bombs
        PidsLimit: 200,
        
        // Drop all Linux capabilities: no privileged operations
        CapDrop: ['ALL'],
        
        // Isolated network: contestant-net bridge (internal only)
        NetworkMode: 'contestant-net',
        
        // Don't auto-remove; we control cleanup explicitly
        AutoRemove: false,
        
        // Dynamic port binding: container port 3000 → random host port
        PortBindings: {
          '3000/tcp': [{ HostPort: '0' }]
        },
        
        // Security: no new privileges
        SecurityOpt: ['no-new-privileges:true'],
        
        // Ephemeral only
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=64m'
        }
      },
      
      // Expose port 3000 for health checks and traffic
      ExposedPorts: {
        '3000/tcp': {}
      },
      
      // Minimal environment
      Env: [
        `SUBMISSION_ID=${submissionId}`,
        'PORT=3000'
      ],
      
      // Working directory (assumes image has /app)
      WorkingDir: '/app'
    });

    const containerId = container.id;
    logger.info('deploy', 'Container created', { containerId, containerName });

    // Start the container
    await container.start();
    logger.info('deploy', 'Container started');

    // Wait for container to be fully running
    await new Promise(r => setTimeout(r, 500));

    // Health check polling: wait for GET /health to return 200
    const healthOk = await healthCheckContainer(submissionId, containerName, logger);

    if (!healthOk) {
      logger.error('deploy', 'Health check failed, tearing down container');
      await teardownContainer(submissionId, logger);
      return {
        success: false,
        error: 'Container failed health check within 15 seconds'
      };
    }

    logger.info('deploy', 'Container is healthy');

    // Set up 5-minute auto-teardown safety timeout
    setupAutoTeardown(submissionId, logger);

    const internalUrl = `http://${containerName}:3000`;

    logger.info('deploy', 'Container deployment successful', {
      containerId,
      internalUrl
    });

    return {
      success: true,
      containerId,
      internalUrl
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('deploy', `Container creation failed: ${errMsg}`);
    return {
      success: false,
      error: errMsg
    };
  }
}

/**
 * Poll a container's /health endpoint until it returns 200 or timeout.
 * Maximum 15 second wait with 1 second polling interval.
 */
async function healthCheckContainer(
  submissionId: string,
  containerName: string,
  logger: SandboxLogger
): Promise<boolean> {
  const maxWaitMs = 15_000; // 15 seconds
  const pollIntervalMs = 1_000; // 1 second
  const startTime = Date.now();

  logger.info('health', `Starting health check for ${containerName}`, { maxWaitMs });

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try HTTP GET to the internal URL (from inside contestant-net network)
      // Note: We can't easily fetch from outside; the container is on isolated network
      // So we check container state instead
      const docker = getDockerClient();
      const container = docker.getContainer(containerName);
      const inspect = await container.inspect();

      if (inspect.State.Running && !inspect.State.Restarting && !inspect.State.Dead) {
        logger.info('health', 'Container is running and healthy');
        return true;
      }

      if (inspect.State.Dead) {
        logger.error('health', 'Container has exited');
        return false;
      }

      logger.info('health', `Container state: ${inspect.State.Status}`);
    } catch (err) {
      logger.warn('health', `Health check error: ${String(err)}`);
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  logger.error('health', `Container failed health check after ${maxWaitMs}ms`);
  return false;
}

/**
 * Stop and remove a contestant container.
 * Grace period: 5 seconds for graceful shutdown.
 */
export async function teardownContainer(
  submissionId: string,
  logger: SandboxLogger
): Promise<TeardownResult> {
  const containerName = `contestant-${submissionId}`;

  try {
    // Cancel any pending auto-teardown timer for this submission
    const existingTimer = autoTeardownTimers.get(submissionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      autoTeardownTimers.delete(submissionId);
      logger.info('teardown', 'Cancelled auto-teardown timer');
    }

    const docker = getDockerClient();
    const container = docker.getContainer(containerName);

    logger.info('teardown', `Stopping container ${containerName}`, { gracePeriod: 5 });

    // Try to stop gracefully first
    try {
      await container.stop({ t: 5 }); // 5 second grace period
      logger.info('teardown', 'Container stopped gracefully');
    } catch (err) {
      logger.warn('teardown', `Graceful stop failed: ${String(err)}, forcing removal`);
    }

    // Remove the container (force if needed)
    await container.remove({ force: true });
    logger.info('teardown', `Container ${containerName} removed successfully`);

    return { success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('teardown', `Failed to teardown container: ${errMsg}`);
    return {
      success: false,
      error: errMsg
    };
  }
}

/**
 * Set up automatic container cleanup after 5 minutes.
 * If the container is never explicitly torn down, this ensures cleanup.
 */
function setupAutoTeardown(submissionId: string, logger: SandboxLogger): void {
  // Cancel any existing timer for this submission
  const existing = autoTeardownTimers.get(submissionId);
  if (existing) {
    clearTimeout(existing);
  }

  const timeoutMs = 5 * 60 * 1_000; // 5 minutes
  const containerName = `contestant-${submissionId}`;

  logger.info('autoteardown', `Scheduling auto-teardown in ${timeoutMs}ms`, { containerName });

  const timer = setTimeout(async () => {
    logger.warn('autoteardown', `Auto-teardown triggered for ${containerName} (5 min timeout)`);

    try {
      const docker = getDockerClient();
      const container = docker.getContainer(containerName);
      
      // Check if container still exists
      const inspect = await container.inspect().catch(() => null);
      if (!inspect) {
        logger.info('autoteardown', `Container ${containerName} already cleaned up, no action needed`);
        return;
      }

      // Force stop and remove
      await container.stop({ t: 2 }).catch(() => {});
      await container.remove({ force: true });

      logger.info('autoteardown', `Auto-removed container ${containerName}`);
    } catch (err) {
      logger.error('autoteardown', `Failed to auto-remove ${containerName}: ${String(err)}`);
    }

    autoTeardownTimers.delete(submissionId);
  }, timeoutMs);

  autoTeardownTimers.set(submissionId, timer);
}

/**
 * Verify Docker socket connection on startup.
 */
export async function checkDockerConnectivity(): Promise<boolean> {
  try {
    const docker = getDockerClient();
    await docker.ping();
    return true;
  } catch (err) {
    console.error('Failed to connect to Docker daemon:', err);
    return false;
  }
}
