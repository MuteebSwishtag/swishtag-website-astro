const API_ORIGIN = 'https://developers.hostinger.com';
const SHA = /^[a-f0-9]{40}$/;
const STATES = new Set(['pending', 'running', 'completed', 'failed']);

function safeString(value, maxLength = 200) {
  return typeof value === 'string' && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

async function boundedJson(response, maxBytes = 1_000_000) {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('oversized response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class HostingerClient {
  constructor({ siteUrl, hostingerAccount = '', hostingerDomain = '', hostingerToken = '', fetchImpl = fetch } = {}) {
    if (siteUrl) {
      const parsed = new URL(siteUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('deployment.siteUrl must be an HTTPS URL without credentials, query or fragment.');
      this.siteUrl = parsed;
    }
    if (hostingerAccount && !/^[A-Za-z0-9_-]{1,64}$/u.test(hostingerAccount)) throw new Error('deployment.hostingerAccount is invalid.');
    if (hostingerDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(hostingerDomain)) throw new Error('deployment.hostingerDomain must be a domain name.');
    this.account = hostingerAccount;
    this.domain = hostingerDomain;
    this.token = hostingerToken;
    this.fetchImpl = fetchImpl;
  }

  async siteStatus(expectedSha) {
    if (!this.siteUrl) return { configured: false };
    const result = { configured: true, reachable: false, httpStatus: null, markerValid: false, sha: null, builtAt: null, matchesExpectedSha: null };
    try {
      const url = new URL('/.well-known/site-release.json', this.siteUrl);
      url.searchParams.set('mcp_status', String(Date.now()));
      const response = await this.fetchImpl(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      result.reachable = true;
      result.httpStatus = response.status;
      if (!response.ok) return { ...result, error: `Release marker returned HTTP ${response.status}; the live revision is unknown.` };
      const marker = await boundedJson(response, 8192);
      if (marker?.schema !== 1 || !(marker.sha === null || (typeof marker.sha === 'string' && SHA.test(marker.sha)))) return { ...result, error: 'Release marker is invalid; the live revision is unknown.' };
      result.markerValid = true;
      result.sha = marker.sha;
      result.builtAt = typeof marker.builtAt === 'string' && !Number.isNaN(Date.parse(marker.builtAt)) ? marker.builtAt : null;
      result.matchesExpectedSha = expectedSha && marker.sha ? marker.sha === expectedSha : null;
      if (!marker.sha) result.error = 'Build omitted Git metadata; the live revision is unknown.';
      return result;
    } catch {
      return { ...result, error: 'Could not verify the configured website release marker.' };
    }
  }

  async buildStatus() {
    if (!this.account || !this.domain || !this.token) return { configured: false, missing: [!this.account && 'deployment.hostingerAccount', !this.domain && 'deployment.hostingerDomain', !this.token && 'MCP_HOSTINGER_TOKEN'].filter(Boolean) };
    try {
      const url = new URL(`/api/hosting/v1/accounts/${encodeURIComponent(this.account)}/websites/${encodeURIComponent(this.domain)}/nodejs/builds`, API_ORIGIN);
      url.searchParams.set('per_page', '20');
      const response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { configured: true, builds: [], error: `Hostinger returned HTTP ${response.status}.` };
      const payload = await boundedJson(response);
      if (!Array.isArray(payload?.data)) return { configured: true, builds: [], error: 'Hostinger returned an invalid builds response.' };
      // Never forward environment variables, raw logs, arbitrary options or API error bodies.
      const builds = payload.data.slice(0, 20).map(build => {
        const source = build?.options?.source_options;
        const sha = source?.commit?.hash;
        return {
          uuid: typeof build?.uuid === 'string' && /^[a-f0-9-]{32,36}$/iu.test(build.uuid) ? build.uuid : null,
          state: STATES.has(build?.state) ? build.state : 'unknown',
          sha: typeof sha === 'string' && SHA.test(sha) ? sha : null,
          branch: safeString(source?.branch),
          createdAt: safeString(build?.created_at, 64),
          updatedAt: safeString(build?.updated_at, 64),
        };
      });
      return { configured: true, builds };
    } catch {
      return { configured: true, builds: [], error: 'Could not retrieve Hostinger build status.' };
    }
  }

  async status({ expectedSha } = {}) {
    if (expectedSha !== undefined && !SHA.test(expectedSha)) throw new Error('expectedSha must be a full lowercase Git commit SHA.');
    const [site, hostinger] = await Promise.all([this.siteStatus(expectedSha), this.buildStatus()]);
    return { site, hostinger };
  }
}
