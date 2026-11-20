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
 *
 * The scan below is the hand-rolled linear equivalent of that pattern
 * rather than the pattern itself: on a long run of matchable characters
 * with no "@" in it (a base64 blob riding an error body), the regex
 * rescans the run from every position before failing — quadratic, long
 * enough to hang an emission path — while a match can only ever begin
 * at a maximal run's start, because the first class's maximal run pins
 * the colon's position and its backtracking can never place it
 * elsewhere. The classes are the regex's own, matched per character.
 */
const USER_CHAR = /[^\s"'():@]/;
const PASS_CHAR = /[^\s"'@]/;

const stripSchemelessUserinfo = (text: string): string => {
  let kept = "";
  let scan = 0;
  let i = 0;
  while (i < text.length) {
    if (!USER_CHAR.test(text[i] as string)) {
      i += 1;
      continue;
    }
    // The maximal user run: only its start can begin a match.
    const start = i;
    let end = start;
    while (end < text.length && USER_CHAR.test(text[end] as string)) {
      end += 1;
    }
    if (text[end] === ":") {
      let q = end + 1;
      while (q < text.length && PASS_CHAR.test(text[q] as string)) {
        q += 1;
      }
      if (q > end + 1 && text[q] === "@") {
        // The match drops wholesale — user, colon, password, and the
        // "@" — and the host after it stays readable.
        kept += text.slice(scan, start);
        scan = q + 1;
        i = q + 1;
        continue;
      }
    }
    i = end;
  }
  return kept + text.slice(scan);
};

/**
 * Matches a token-bearing query parameter and captures everything up to
 * the "="; the value itself runs to the next "&", whitespace, or quote
 * and is replaced wholesale. Case-insensitive on the parameter name.
 */
const QUERY_TOKEN =
  /([?&](?:token|access_token|password|secret|api_key|key)=)[^&\s"']*/gi;

export function redactSecrets(text: string): string {
  return stripSchemelessUserinfo(
    text.replace(CREDENTIALED_URL, (match) =>
      match.slice(0, match.indexOf("://") + 3),
    ),
  ).replace(QUERY_TOKEN, "$1[redacted]");
}
