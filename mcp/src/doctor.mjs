import { loadConfig } from './config.mjs';
try {
  const config = await loadConfig();
  const checks = {
    config: 'valid', oauth: 'configured; real sign-in still requires provider/client registration',
    github: config.github.token ? 'credential present; not verified' : 'MISSING MCP_GITHUB_TOKEN',
    wordpress: config.wordpress.username && config.wordpress.applicationPassword ? 'credentials present; not verified' : 'MISSING WordPress application credentials',
    hostingerBuildApi: config.deployment.hostingerAccount && config.deployment.hostingerDomain && config.deployment.hostingerToken ? 'configured; not verified' : 'optional; build API unavailable',
    deploymentBranch: config.github.baseBranch,
  };
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  if (!config.github.token || !config.wordpress.username || !config.wordpress.applicationPassword) process.exitCode = 1;
} catch {
  process.stderr.write('MCP configuration missing or invalid. Copy mcp/config.example.json to mcp/config.json, configure OAuth and add individual subjects. See docs/mcp-setup.md.\n');
  process.exitCode = 1;
}
