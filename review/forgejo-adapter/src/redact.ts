/**
 * Credential redaction for composed error text. The forge adapter embeds
 * adapter-supplied strings — a credentialed clone URL, a response body —
 * into errors; this strips URL userinfo and query-token values so none of
 * those surfaces carries a secret.
 */

const CREDENTIALED_URL = /(?:https?|ssh|git|file):\/\/[^\s@]*@/g;
const SCHEMELESS_USERINFO = /[^\s"'():@]+:[^\s"'@]+@/g;
const QUERY_TOKEN =
  /([?&](?:token|access_token|password|secret|api_key|key)=)[^&\s"']*/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(CREDENTIALED_URL, (match) =>
      match.slice(0, match.indexOf("://") + 3),
    )
    .replace(SCHEMELESS_USERINFO, "")
    .replace(QUERY_TOKEN, "$1[redacted]");
}
