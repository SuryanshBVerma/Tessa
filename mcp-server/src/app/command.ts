// Parses `app.start` from config into an argument vector.
//
// The command comes from a committed config file, but Tessa still treats it as untrusted: only a
// conservative character set is allowed, so nothing in it can be interpreted by a shell. That
// matters on Windows, where `npm` and similar tools are .cmd files that Node can only start
// through cmd.exe.

const SAFE_TOKEN = /^[A-Za-z0-9_@+=:,./\\ -]+$/;

export class UnsafeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCommandError';
  }
}

export interface ParsedCommand {
  program: string;
  args: string[];
}

export function parseCommand(command: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const char of command) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (char === ' ' || char === '\t') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (quote !== null) {
    throw new UnsafeCommandError('app.start has an unclosed quote');
  }
  if (hasToken) {
    tokens.push(current);
  }

  const [program, ...args] = tokens;
  if (program === undefined || program === '') {
    throw new UnsafeCommandError('app.start is empty');
  }
  for (const token of tokens) {
    if (!SAFE_TOKEN.test(token)) {
      throw new UnsafeCommandError(
        'app.start may only contain letters, digits, spaces and _ @ + = : , . / \\ -. ' +
          'Shell operators such as &&, |, > and $ are not allowed; wrap complex startup in a package script.',
      );
    }
  }
  return { program, args };
}

/** Quotes a token for cmd.exe. Safe because SAFE_TOKEN excludes quotes and cmd metacharacters. */
export function quoteForCmd(token: string): string {
  return token.includes(' ') ? `"${token}"` : token;
}
