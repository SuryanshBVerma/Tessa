export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TicketInput {
  title: string;
  description: string;
  priority: Priority;
}

export type TicketErrors = Partial<Record<keyof TicketInput, string>>;

export type ValidationResult =
  { ok: true; value: TicketInput } | { ok: false; errors: TicketErrors };

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function validateTicketInput(form: FormData): ValidationResult {
  const title = field(form, 'title');
  const description = field(form, 'description');
  const priorityRaw = field(form, 'priority') || 'medium';
  const errors: TicketErrors = {};

  if (title.length < 3 || title.length > 120) {
    errors.title = 'Title must be between 3 and 120 characters.';
  }
  if (description.length > 2000) {
    errors.description = 'Description must be 2000 characters or fewer.';
  }
  const priority = PRIORITIES.find((p) => p === priorityRaw);
  if (priority === undefined) {
    errors.priority = 'Choose low, medium, or high.';
  }

  if (priority === undefined || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { title, description, priority } };
}
