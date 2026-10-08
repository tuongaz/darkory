/**
 * A word for a POSIX shell, as a command the app offers to copy must carry it: unchanged when it
 * holds only letters, digits and `_.@-`, else in single quotes, inside which nothing expands
 * (`$(…)`, backticks, `$VAR`, newlines), each `'` written as `'\''`.
 */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_.@-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}
