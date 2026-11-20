/**
 * Credential redaction for composed error text. The git helper and the
 * forge adapter embed adapter-supplied strings — a credentialed clone URL,
 * a response body — into errors that reach the PR failure comment, the
 * logs, and the journal; this strips URL userinfo and query-token values
 * so none of those surfaces carries a secret.
 */

/**
 * Matches "scheme://userinfo@" for every scheme a clone URL may use. The
 * match is bounded by whitespace and runs up to the first "@": it may not
 * stop short at a "/" (some hosts accept "user:pass/team@host"), and it
 * cannot swallow past a space, so a plain scheme'd URL followed by other
 * text in the same message is left intact. The userinfo (user and
 * password) is dropped wholesale; the host after the "@" stays readable.
 */
const CREDENTIALED_URL = /(?:https?|ssh|git|file):\/\/[^\s@]*@/g;

/**
 * Matches the scheme-less credential shape "user:pass@host". Requiring
 * the ":" separator keeps ordinary "name@host" mentions (an email
 * address, a committer line) from matching, and the classes stop at
 * whitespace and quotes so one match cannot run across a sentence.
 */
const SCHEMELESS_USERINFO = /[^\s"'():@]+:[^\s"'@]+@/g;

/**
 * Matches a token-bearing query parameter and captures everything up to
 * the "="; the value itself runs to the next "&", whitespace, or quote
 * and is replaced wholesale. Case-insensitive on the parameter name.
 */
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
