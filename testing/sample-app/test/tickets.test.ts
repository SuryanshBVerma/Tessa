import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../app/lib/redirect';
import { validateTicketInput } from '../app/lib/tickets';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

describe('validateTicketInput', () => {
  it('accepts a valid ticket and defaults priority to medium', () => {
    expect(validateTicketInput(form({ title: '  Broken link  ', description: '' }))).toEqual({
      ok: true,
      value: { title: 'Broken link', description: '', priority: 'medium' },
    });
  });

  it('rejects a short title', () => {
    const result = validateTicketInput(form({ title: 'ab' }));
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.errors.title).toMatch(/between 3 and 120/);
  });

  it('rejects an unknown priority', () => {
    const result = validateTicketInput(form({ title: 'Valid title', priority: 'urgent' }));
    expect(result.ok ? undefined : result.errors.priority).toBeDefined();
  });
});

describe('safeRedirect', () => {
  it.each([
    ['/tickets/2', '/tickets/2'],
    ['/admin/users?x=1', '/admin/users?x=1'],
    ['https://evil.example', '/tickets'],
    ['//evil.example', '/tickets'],
    ['/\\evil.example', '/tickets'],
    ['tickets', '/tickets'],
  ])('%s → %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });

  it('falls back when the value is missing', () => {
    expect(safeRedirect(null)).toBe('/tickets');
  });
});
