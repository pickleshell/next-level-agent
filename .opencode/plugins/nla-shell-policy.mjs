// OpenCode exposes bash as one coarse capability; it has no command-level
// permission grammar. Block the high-risk forms we can see at the NLA hook
// boundary, while keeping ordinary test/build commands available.
const COMMAND_PREFIX = String.raw`(?:^|[;&|]|\$\()\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;|&]+))\s+)*`;
const ENVIRONMENT_DUMP = new RegExp(`${COMMAND_PREFIX}(?:command\\s+)?(?:\\/[\\w./-]+\\/)?(?:env|printenv)\\b`, 'i');
const SHELL_STATE_DUMP = new RegExp(`${COMMAND_PREFIX}(?:export\\s+-p|declare\\s+-p|set)\\s*(?:$|[;&|])`, 'i');
const PROC_ENVIRONMENT = /\/proc\/(?:self|\d+)\/environ\b/i;
const PRIVILEGE_ESCAPE = new RegExp(`${COMMAND_PREFIX}(?:\/[\w./-]+\/)?(?:sudo|doas|runuser|su)\\b`, 'i');
const NESTED_SHELL = new RegExp(`${COMMAND_PREFIX}(?:\\/[\\w./-]+\\/)?(?:bash|sh|dash|zsh)\\s+-[A-Za-z]*c\\b`, 'i');

export function isEnvironmentDumpCommand(command) {
  if (typeof command !== 'string') return false;
  return ENVIRONMENT_DUMP.test(command) || SHELL_STATE_DUMP.test(command) || PROC_ENVIRONMENT.test(command)
    || PRIVILEGE_ESCAPE.test(command) || NESTED_SHELL.test(command);
}

export function assertSafeNlaShellCommand(command) {
  if (!isEnvironmentDumpCommand(command)) return;
  const error = new Error('NLA role policy blocks environment-dump, nested-shell, and privilege-escalation commands; use a minimal allowlisted diagnostic instead');
  error.code = 'NLA_SHELL_POLICY_BLOCKED';
  throw error;
}
