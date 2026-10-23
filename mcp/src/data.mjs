import { z } from 'zod';
import { ServiceError } from './github.mjs';

const safeText = z.string().max(20000);
const safeHref = z.string().max(2000).refine(value => {
  if (/[\\\x00-\x20\x7f]/.test(value)) return false;
  if (/^\/(?!\/)/.test(value)) return true;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
});
const faq = z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.object({
  eyebrow: safeText.optional(), title: safeText, description: safeText.optional(),
  link: z.object({ href: safeHref, label: safeText }).strict().optional(),
  items: z.array(z.object({ question: safeText, answer: safeText, open: z.boolean().optional() }).strict()).min(1).max(100),
}).strict());

export function validateData(path, content) {
  let data; try { data = JSON.parse(content); } catch { throw new ServiceError('JSON content is invalid.', 'invalid_content'); }
  if (path === 'src/data/faqs.json' && !faq.safeParse(data).success) throw new ServiceError('FAQ data must match the existing text/link/item schema and use safe link URLs.', 'invalid_content');
  return data;
}
