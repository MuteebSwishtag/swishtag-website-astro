// Hostinger imports entry files instead of executing them as the main module.
// Keep server.mjs importable by tests; this dedicated entry always starts it.
import { start } from './server.mjs';
import { ConfigurationError } from './config.mjs';

await start().catch(error => {
  const message = error instanceof ConfigurationError ? error.message
    : 'Check configuration, credentials and audit-directory permissions.';
  process.stderr.write(`MCP startup failed: ${message}\n`);
  process.exitCode = 1;
});
