import { ServiceError } from './github.mjs';

const ROOT_FILES = new Set(['astro.config.mjs', 'package.json', 'package-lock.json', 'tsconfig.json']);
export function sitePath(path) {
  if (typeof path !== 'string' || path.length > 240 || !/^[a-zA-Z0-9_@()[\]./ -]+$/.test(path)
    || path.includes('\\') || path.includes('//') || path.startsWith('/') || path.split('/').some(p => !p || p === '..' || p.startsWith('.'))
    || /(?:^|\/)(?:node_modules|dist|mcp)(?:\/|$)/i.test(path)
    || /(?:^|\/)(?:.*\.env.*|.*(?:secret|credential|private[-_]?key).*|swishtag-mail-config\.php)$/i.test(path)) {
    throw new ServiceError('Path is outside the editable website source.', 'invalid_path');
  }
  if (!(path.startsWith('src/') || path.startsWith('public/') || ROOT_FILES.has(path))) {
    throw new ServiceError('Only website source files can be accessed; MCP policy, workflows, credentials and audit files are protected.', 'invalid_path');
  }
  return path;
}
export function editPermission(path) {
  sitePath(path);
  if (path === 'src/data/redirects.json') return 'redirects.edit';
  if (path === 'src/components/layout/Footer.astro') return 'footer.edit';
  if (/^src\/components\/layout\/(Header|HeaderBehavior)\.astro$/.test(path)) return 'navigation.edit';
  if (path.startsWith('src/layouts/')) return 'layouts.edit';
  // These files execute on the server, contain inline scripts, or change build dependencies.
  // Text replacement cannot safely constrain an Astro/JS edit to SEO or visible copy.
  if (path.startsWith('src/lib/') || path.startsWith('src/pages/api/') || ROOT_FILES.has(path)) return 'website.full';
  if (path.startsWith('src/pages/')) return 'pages.edit';
  if (path.startsWith('public/')) return 'assets.edit';
  return 'content.edit';
}
export function rawEditPermission(path) {
  sitePath(path);
  // Structured tools keep non-developers out of executable Astro/JS/PHP source.
  // Raw code editing is an explicit full-website capability.
  if (path === 'src/data/faqs.json') return 'content.edit';
  if (/\.css$/i.test(path)) return 'assets.edit';
  return 'website.full';
}
export function validateImage(path, base64) {
  sitePath(path);
  if (typeof base64 !== 'string' || base64.length > 7_000_000) throw new ServiceError('Image exceeds the encoded size limit.', 'invalid_image');
  if (!path.startsWith('public/') || !/\.(png|jpe?g|gif|webp)$/i.test(path)) throw new ServiceError('Images must be PNG, JPEG, GIF or WebP under public/.', 'invalid_image');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new ServiceError('Invalid base64 image.', 'invalid_image');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new ServiceError('Image must be between 1 byte and 5 MiB.', 'invalid_image');
  const signatures = { png: bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    jpg: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    gif: ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()),
    webp: bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' };
  let ext = path.split('.').at(-1).toLowerCase(); if (ext === 'jpeg') ext = 'jpg';
  if (!signatures[ext]) throw new ServiceError('Image bytes do not match the filename.', 'invalid_image');
  return bytes;
}
