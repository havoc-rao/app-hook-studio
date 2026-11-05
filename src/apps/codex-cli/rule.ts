/** App Hook Studio owns the launch rule; the official CLI and its package-manager entry stay intact. */
export const codexCliRule = {
 id: 'codex-cli-dual-approval-v1',
 title: 'Codex CLI 双入口',
 registration: 'managed-zsh-function',
 officialEntry: '/opt/homebrew/bin/codex',
 transport: 'websocket-over-private-unix-socket',
 requiredCapability: '--remote',
 minimumNodeMajor: 22,
} as const;
