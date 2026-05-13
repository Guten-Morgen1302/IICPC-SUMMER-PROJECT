/**
 * Docker image builder for contestant submissions.
 *
 * Uses dockerode SDK to:
 * - Build Docker images from contestant submission source
 * - Generate default Dockerfile if missing
 * - Stream build logs to structured logger
 * - Tag image with deterministic name: contestant-{submissionId}:latest
 */
import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { BuildLogger } from './buildLogger';

// Default Dockerfile template for Node.js engines
const DEFAULT_DOCKERFILE = `FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install --if-present
EXPOSE 3000
CMD ["node", "index.js"]
`;

/**
 * Initialize Docker client.
 * On Unix: connects to /var/run/docker.sock
 * On Windows: connects to Docker Desktop named pipe \\.\pipe\docker_engine
 */
export function getDockerClient(): Docker {
  return new Docker();
}

/**
 * Generate a default Dockerfile if one doesn't exist.
 * Returns true if Dockerfile was created, false if it already existed.
 */
export function ensureDockerfile(srcDir: string, logger: BuildLogger): boolean {
  const dockerfilePath = path.join(srcDir, 'Dockerfile');
  
  if (fs.existsSync(dockerfilePath)) {
    logger.info('docker', 'Dockerfile already present in submission');
    return false;
  }

  logger.info('docker', 'Generating default Dockerfile for Node.js engine');
  fs.writeFileSync(dockerfilePath, DEFAULT_DOCKERFILE, 'utf8');
  return true;
}

export interface BuildResult {
  imageName: string;
  imageId: string;
  succeeded: boolean;
  error?: string;
}

/**
 * Build a Docker image from the contestant submission.
 *
 * Uses Docker CLI directly via spawnSync for maximum compatibility.
 * This is simpler than dockerode for now and works reliably cross-platform.
 *
 * @param submissionId - Used for deterministic image tagging
 * @param srcDir - Absolute path to extracted submission source
 * @param logger - Structured logger for build events
 * @returns BuildResult with image name or error
 */
export async function buildContestantImage(
  submissionId: string,
  srcDir: string,
  logger: BuildLogger
): Promise<BuildResult> {
  const imageName = `contestant-${submissionId.toLowerCase()}:latest`;

  try {
    logger.info('docker', 'Starting Docker image build', {
      imageName,
      context: srcDir
    });

    // Ensure Dockerfile exists (create default if needed)
    ensureDockerfile(srcDir, logger);

    // Build the image using Docker CLI
    const buildCmd = `docker build -t ${imageName} .`;
    logger.info('docker', `Executing: ${buildCmd} (cwd: ${srcDir})`);

    const result = spawnSync('docker', ['build', '-t', imageName, '.'], {
      cwd: srcDir,
      encoding: 'utf8',
      timeout: 300_000, // 5 minutes
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.error) {
      const errMsg = result.error.message;
      logger.error('docker', `Docker spawn failed: ${errMsg}`);
      return {
        imageName,
        imageId: '',
        succeeded: false,
        error: errMsg
      };
    }

    // Log stdout (build steps)
    if (result.stdout) {
      result.stdout.split('\n').forEach((line: string) => {
        if (line.trim()) {
          logger.info('docker:build', line);
        }
      });
    }

    // Log stderr (warnings, errors)
    if (result.stderr) {
      result.stderr.split('\n').forEach((line: string) => {
        if (line.trim()) {
          logger.warn('docker:build', line);
        }
      });
    }

    if (result.status !== 0) {
      const errMsg = `Docker build exited with code ${result.status}`;
      logger.error('docker', errMsg);
      return {
        imageName,
        imageId: '',
        succeeded: false,
        error: errMsg
      };
    }

    logger.info('docker', 'Docker image built successfully', { imageName });

    return {
      imageName,
      imageId: '', // Would need to inspect image to get ID, but not critical
      succeeded: true
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('docker', `Failed to build image: ${errMsg}`);
    return {
      imageName,
      imageId: '',
      succeeded: false,
      error: errMsg
    };
  }
}
