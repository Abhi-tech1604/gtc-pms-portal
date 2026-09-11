import { randomUUID } from 'node:crypto';

/** Prefixed identifier, e.g. eq_3f2a…. Prefixes make log lines readable. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
