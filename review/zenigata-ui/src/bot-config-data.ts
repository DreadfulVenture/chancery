/**
 * The configuration echo's data: the bot's own configured facts, shown
 * plainly — none of them a secret.
 */

export interface StatusConfig {
  listenPort: number;
  allowedLogins: number;
  allowedRepos: number;
  retryPolicy: string;
  reviewTimeoutSeconds: number;
  turnPollSeconds: number;
  turnBudgetSeconds: number;
  agent: string;
}
