import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { githubApi } from './github.js';
import { createModel } from '../ai/model.js';
import { getConfig } from '../config.js';
/**
 * Generate a short descriptive title for an agent job using the LLM.
 * Uses structured output to avoid thinking-token leaks with extended-thinking models.
 * @param {string} agentJobDescription - The full job description
 * @returns {Promise<string>} ~10 word title
 */
async function generateAgentJobTitle(agentJobDescription) {
  try {
    const model = await createModel({ maxTokens: 100 });
    const response = await model.withStructuredOutput(z.object({ title: z.string() })).invoke([
      ['system', 'Generate a descriptive ~10 word title for this agent job. The title should clearly describe what the job will do.'],
      ['human', agentJobDescription],
    ]);
    return response.title.trim() || agentJobDescription.slice(0, 80);
  } catch {
    // Fallback: first line, truncated
    const firstLine = agentJobDescription.split('\n').find(l => l.trim()) || agentJobDescription;
    return firstLine.replace(/^#+\s*/, '').trim().split(/\s+/).slice(0, 10).join(' ');
  }
}

/**
 * Create a new agent job: push branch to GitHub, then launch a local Docker container.
 * @param {string} agentJobDescription - The job description
 * @param {Object} [options] - Optional overrides
 * @param {string} [options.llmModel] - LLM model override
 * @param {string} [options.agentBackend] - Agent backend override ('claude-code', 'pi', etc.)
 * @returns {Promise<{agent_job_id: string, branch: string, title: string}>}
 */
async function createAgentJob(agentJobDescription, options = {}) {
  const { GH_OWNER, GH_REPO } = process.env;
  const agentJobId = uuidv4();
  const branch = `agent-job/${agentJobId}`;
  const repo = `/repos/${GH_OWNER}/${GH_REPO}`;

  // Generate a short descriptive title
  const title = await generateAgentJobTitle(agentJobDescription);

  // 1. Get main branch SHA and its tree SHA
  const mainRef = await githubApi(`${repo}/git/ref/heads/main`);
  const mainSha = mainRef.object.sha;
  const mainCommit = await githubApi(`${repo}/git/commits/${mainSha}`);
  const baseTreeSha = mainCommit.tree.sha;

  // 2. Build agent-job.config.json — single source of truth for job metadata
  const config = { title, job: agentJobDescription };
  if (options.llmModel) config.llm_model = options.llmModel;
  if (options.agentBackend) config.agent_backend = options.agentBackend;

  const treeEntries = [
    {
      path: `logs/${agentJobId}/agent-job.config.json`,
      mode: '100644',
      type: 'blob',
      content: JSON.stringify(config, null, 2),
    },
  ];

  // 3. Create tree (base_tree preserves all existing files)
  const tree = await githubApi(`${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeEntries,
    }),
  });

  // 4. Create a single commit with job config
  const commit = await githubApi(`${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `🤖 Agent Job: ${title}`,
      tree: tree.sha,
      parents: [mainSha],
    }),
  });

  // 5. Create branch pointing to the commit
  await githubApi(`${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    }),
  });

  // 6. Launch the agent-job container. By default this prefers a remote
  //    conclave node (if any are connected and label-matched), and falls
  //    back to a local Docker container. CONCLAVE_DISPATCH_AGENT_JOB
  //    overrides: 'always' = require dispatch (no fallback), 'never' = always
  //    local, 'auto' (default) = try remote then fall back.
  const repoSlug = `${GH_OWNER}/${GH_REPO}`;
  launchAgentJob({
    agentJobId,
    repo: repoSlug,
    branch,
    title,
    description: agentJobDescription,
    codingAgent: options.agentBackend,
    llmModel: options.llmModel,
    nodeLabels: options.nodeLabels || [],
  }).catch(err => {
    console.error(`[agent-job] Failed to launch ${agentJobId}:`, err.message);
  });

  return { agent_job_id: agentJobId, branch, title };
}

/**
 * Launch an agent-job, choosing between a remote conclave worker node and a
 * local Docker container based on CONCLAVE_DISPATCH_AGENT_JOB:
 *
 *   'auto'   (default) — try remote, fall back to local on failure
 *   'always'           — require remote, fail loudly if no node is eligible
 *   'never'            — always launch locally
 */
async function launchAgentJob(params) {
  const mode = (process.env.CONCLAVE_DISPATCH_AGENT_JOB || 'auto').toLowerCase();
  const shortId = params.agentJobId.slice(0, 8);

  if (mode !== 'never') {
    try {
      await dispatchAgentJobToNode(params);
      return;
    } catch (err) {
      if (mode === 'always') {
        console.error(`[agent-job] ${shortId} dispatch failed (mode=always, no fallback):`, err.message);
        throw err;
      }
      console.warn(`[agent-job] ${shortId} dispatch failed, falling back to local: ${err.message}`);
    }
  }

  await launchAgentJobContainerLocal(params);
}

/**
 * Build the container spec via the shared helper, then send it to a
 * conclave node-worker over the WS hub. Resolves on the worker's job.result.
 */
async function dispatchAgentJobToNode(params) {
  const [{ buildAgentJobContainerSpec }, { dispatchToNode }] = await Promise.all([
    import('./docker.js'),
    import('../transport/ws-hub.js'),
  ]);

  const spec = await buildAgentJobContainerSpec(params);
  const shortId = spec.shortId;

  console.log(`[agent-job] ${shortId} dispatching agent=${spec.agent} image=${spec.image} labels=${(params.nodeLabels || []).join(',') || '∅'}`);

  const result = await dispatchToNode({
    runtime: 'docker',
    labels: params.nodeLabels || [],
    payload: {
      image: spec.image,
      containerName: spec.containerName,
      env: spec.env,
      hostConfig: spec.hostConfig,
      volumeName: spec.volumeName,
    },
    jobKind: 'agent-job',
    jobKey: params.agentJobId,
  });

  console.log(`[agent-job] ${shortId} remote exit=${result.exitCode}`);
}

/**
 * Original local-Docker path. Retained as the fallback for mode=auto and the
 * primary path for mode=never.
 */
async function launchAgentJobContainerLocal(params) {
  const { runAgentJobContainer, waitForContainer, removeVolume } = await import('./docker.js');

  const { containerName, volumeName } = await runAgentJobContainer(params);

  try {
    const exitCode = await waitForContainer(containerName);
    console.log(`[agent-job] ${params.agentJobId.slice(0, 8)} (local) exited with code ${exitCode}`);
  } catch (err) {
    console.error(`[agent-job] wait error for ${params.agentJobId.slice(0, 8)}:`, err.message);
  }

  try {
    await removeVolume(volumeName);
    console.log(`[agent-job] volume ${volumeName} removed`);
  } catch (err) {
    console.error(`[agent-job] failed to remove volume ${volumeName}:`, err.message);
  }
}

export { createAgentJob };
