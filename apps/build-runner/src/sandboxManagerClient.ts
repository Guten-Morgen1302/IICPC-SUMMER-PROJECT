/**
 * Sandbox-manager HTTP client.
 *
 * Calls sandbox-manager:3003/deploy to notify about successful builds
 * and request container deployment.
 */
import { BuildLogger } from './buildLogger';

const SANDBOX_MANAGER_BASE = process.env.SANDBOX_MANAGER_URL || 'http://sandbox-manager:3003';

export interface DeployRequest {
  submissionId: string;
  imageName: string;
}

export interface DeployResponse {
  containerId: string;
  internalUrl: string;
  deployedAt: string;
}

/**
 * POST to sandbox-manager to deploy a built image.
 *
 * @param request Deploy parameters
 * @param logger Structured logger
 * @returns Deploy response or null if failed
 */
export async function deployImage(
  request: DeployRequest,
  logger: BuildLogger
): Promise<DeployResponse | null> {
  try {
    const url = `${SANDBOX_MANAGER_BASE}/deploy`;

    logger.info('sandbox', 'Requesting container deployment', {
      url,
      submissionId: request.submissionId,
      imageName: request.imageName
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000) // 30s timeout
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.error('sandbox', `Deploy request failed with status ${response.status}`, {
        message: text
      });
      return null;
    }

    const body = (await response.json()) as DeployResponse;

    logger.info('sandbox', 'Container deployed successfully', {
      containerId: body.containerId,
      internalUrl: body.internalUrl
    });

    return body;
  } catch (err) {
    logger.error('sandbox', `Failed to deploy image: ${String(err)}`);
    return null;
  }
}
