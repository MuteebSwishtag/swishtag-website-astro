const SHA = /^[a-f0-9]{40}$/;
export class ServiceError extends Error {
  constructor(message, code = 'operation_failed', status = 400) {
    super(message); this.code = code; this.status = status;
  }
}
export function assertSha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new ServiceError('A complete 40-character commit SHA is required.', 'invalid_sha');
  return value;
}

function assertBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 200 || !/^[A-Za-z0-9_./-]+$/.test(branch)
    || branch.startsWith('-') || branch.includes('..') || branch.includes('//')
    || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock') || part.endsWith('.'))) {
    throw new ServiceError('Invalid repository branch.', 'invalid_branch');
  }
  return branch;
}

async function boundedJson(response) {
  const maxBytes = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ServiceError('GitHub response exceeds the service size limit.', 'response_too_large', 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError('GitHub returned an empty response.', 'github_error', 502);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ServiceError('GitHub response exceeds the service size limit.', 'response_too_large', 502);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('GitHub returned invalid JSON.', 'github_error', 502); }
}

export class GitHubClient {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config; this.fetch = fetchImpl;
    this.root = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }
  async request(path, { method = 'GET', body, missing = false } = {}) {
    if (!this.config.token) throw new ServiceError('MCP_GITHUB_TOKEN is not configured.', 'missing_credentials', 503);
    let response;
    try { response = await this.fetch(`https://api.github.com${this.root}${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'swishtag-website-mcp' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000),
    }); } catch { throw new ServiceError('GitHub connection failed. Check connectivity and server configuration.', 'github_error', 502); }
    if (response.status === 404 && missing) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      const conflict = response.status === 409 || response.status === 422;
      throw new ServiceError(conflict ? 'Repository changed or branch policy rejected the update. Inspect the current head before retrying.'
        : `GitHub request failed (HTTP ${response.status}). Check repository permissions and API limits.`,
      conflict ? 'conflict' : 'github_error', conflict ? 409 : 502);
    }
    if (response.status === 204) return {};
    try { return await boundedJson(response); }
    catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('GitHub response could not be read.', 'github_error', 502);
    }
  }
  async head(branch = this.config.baseBranch) {
    return assertSha((await this.request(`/git/ref/heads/${encodeURIComponent(assertBranch(branch))}`)).object.sha);
  }
  commit(sha) { return this.request(`/git/commits/${assertSha(sha)}`); }
  async tree(sha) {
    const result = await this.request(`/git/trees/${assertSha(sha)}?recursive=1`);
    if (result.truncated) throw new ServiceError('Repository tree exceeds the API limit.', 'tree_too_large');
    return result.tree;
  }
  async read(path, sha, maxBytes = 1024 * 1024) {
    const entry = (await this.tree(sha)).find(item => item.path === path);
    if (!entry) throw new ServiceError('File does not exist at this revision.', 'not_found', 404);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new ServiceError('Only regular repository files are supported.', 'invalid_file');
    if (entry.size > maxBytes) throw new ServiceError('File exceeds the tool size limit.', 'file_too_large');
    const blob = await this.request(`/git/blobs/${assertSha(entry.sha)}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new ServiceError('GitHub returned an unsupported blob encoding.', 'invalid_file');
    const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    if (bytes.length > maxBytes) throw new ServiceError('File exceeds the tool size limit.', 'file_too_large');
    return { bytes, sha: entry.sha, size: bytes.length };
  }
  async writeCommit(parent, edits, message) {
    const previous = await this.commit(parent);
    const tree = [];
    for (const edit of edits) {
      const mode = edit.mode ?? '100644';
      if (!['100644', '100755'].includes(mode)) throw new ServiceError('Only regular repository file modes are supported.', 'invalid_file');
      if (edit.bytes === null) { tree.push({ path: edit.path, mode: '100644', type: 'blob', sha: null }); continue; }
      if (edit.sha !== undefined) { tree.push({ path: edit.path, mode, type: 'blob', sha: assertSha(edit.sha) }); continue; }
      const blob = await this.request('/git/blobs', { method: 'POST', body: { content: edit.bytes.toString('base64'), encoding: 'base64' } });
      tree.push({ path: edit.path, mode, type: 'blob', sha: assertSha(blob.sha) });
    }
    const createdTree = await this.request('/git/trees', { method: 'POST', body: { base_tree: previous.tree.sha, tree } });
    return this.request('/git/commits', { method: 'POST', body: { message, tree: createdTree.sha, parents: [parent] } });
  }
  createBranch(branch, sha) {
    return this.request('/git/refs', { method: 'POST', body: { ref: `refs/heads/${assertBranch(branch)}`, sha: assertSha(sha) } });
  }
  advance(branch, sha) {
    return this.request(`/git/refs/heads/${encodeURIComponent(assertBranch(branch))}`, { method: 'PATCH', body: { sha: assertSha(sha), force: false } });
  }
  async compare(base, head) {
    return this.request(`/compare/${assertSha(base)}...${assertSha(head)}`);
  }
  async dispatch(sha) {
    await this.request(`/actions/workflows/${encodeURIComponent(this.config.workflow)}/dispatches`, {
      method: 'POST', body: { ref: this.config.baseBranch, inputs: { ref: assertSha(sha) } },
    });
    return { sha, state: 'queued', workflow: this.config.workflow };
  }
  async validation(sha) {
    assertSha(sha);
    const result = await this.request(`/actions/workflows/${encodeURIComponent(this.config.workflow)}/runs?event=workflow_dispatch&per_page=100`);
    const run = result.workflow_runs.find(item => item.display_title === `MCP Validate ${sha}`
      && item.head_branch === this.config.baseBranch && item.event === 'workflow_dispatch'
      && (!item.path || item.path.split('@')[0] === `.github/workflows/${this.config.workflow}`)
      && (!item.repository?.full_name || item.repository.full_name.toLowerCase() === `${this.config.owner}/${this.config.repo}`.toLowerCase()));
    if (!run) return { sha, state: 'not_started', valid: false };
    if (!Number.isSafeInteger(run.id) || run.id < 1) throw new ServiceError('GitHub returned an invalid validation run.', 'github_error', 502);
    const artifacts = await this.request(`/actions/runs/${run.id}/artifacts?per_page=100`);
    const belongsToRun = item => !item.expired && (!item.workflow_run || item.workflow_run.id === run.id);
    const receipt = artifacts.artifacts.find(item => item.name === `mcp-validation-${sha}` && belongsToRun(item));
    const build = artifacts.artifacts.find(item => item.name === `mcp-build-${sha}` && belongsToRun(item));
    return { sha, runId: run.id, state: run.status, conclusion: run.conclusion, url: run.html_url,
      valid: run.status === 'completed' && run.conclusion === 'success' && !!receipt && !!build,
      artifacts: artifacts.artifacts.filter(item => !item.expired).map(item => ({ name: item.name, id: item.id, expiresAt: item.expires_at })),
    };
  }
  async preview(branch, summary) {
    const open = await this.request(`/pulls?state=open&head=${encodeURIComponent(`${this.config.owner}:${branch}`)}&base=${encodeURIComponent(this.config.baseBranch)}`);
    const pr = open[0] ?? await this.request('/pulls', { method: 'POST', body: { head: branch, base: this.config.baseBranch,
      title: `Website preview: ${summary}`.slice(0, 200), body: 'Website change prepared through the authenticated Swishtag MCP service. Hostinger creates a preview when PR previews are enabled.', draft: true } });
    const comments = await this.request(`/issues/${pr.number}/comments?per_page=100`);
    const previews = [];
    for (const comment of comments) {
      // Only GitHub App bot comments qualify; arbitrary human links are not deployment evidence.
      if (comment.user?.type !== 'Bot' || !this.config.previewBotLogins?.includes(comment.user?.login)) continue;
      for (const match of (comment.body ?? '').matchAll(/https:\/\/[a-zA-Z0-9.-]+\.hostingersite\.com(?:\/[^\s<>)]*)?/g)) {
        previews.push({ url: match[0], commentUrl: comment.html_url });
      }
    }
    return { pullRequest: pr.number, url: pr.html_url, previews, state: previews.length ? 'available' : 'waiting_for_hostinger',
      note: 'Preview links may refer to an earlier build. Check the commit in Hostinger’s PR comment against the change head.' };
  }
}
