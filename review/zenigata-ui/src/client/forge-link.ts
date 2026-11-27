/**
 * The forge links: the PR cells' link composition and the identity cell
 * they render into. The forge URL rides the /page feed; the link is
 * deliberately a link, not an intake mutation — the intake is
 * internet-exposed, so a mutation with no auth story is the wrong
 * shape; on the forge's PR page, re-requesting the review is the
 * forge's own control, and the re-request rides the same webhook path
 * as today's starts (each a fresh delivery id — the retry contract is
 * untouched).
 */

import { html, nothing } from "lit";

/**
 * The forge URL of one pull request: the repo string is the forge path —
 * "example/repo" maps to `{forgeUrl}/example/repo/pulls/{pr}` — with
 * each path segment URI-encoded so a stray repo string cannot escape the
 * path, and a bare name (no owner), `.`/`..`, or empty segments refused
 * for the same reason — none of them has a forge PR page. An undefined
 * answer leaves the caller no URL: it renders the plain-text identity
 * instead. Exported for the tests.
 */
export const forgePullUrl = (
  repo: string,
  pr: number,
  forgeUrl: string,
): string | undefined => {
  const segments = repo.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  const base = forgeUrl.replace(/\/+$/, "");
  return `${base}/${segments.map(encodeURIComponent).join("/")}/pulls/${pr}`;
};

/**
 * A pull request cell: the identity linked into the forge, and — when
 * affordance is set — a second anchor on the same forge PR page.
 */
export const pullCell = (
  repo: string,
  pr: number,
  forgeUrl: string,
  affordance?: string,
): ReturnType<typeof html> => {
  const url = forgePullUrl(repo, pr, forgeUrl);
  if (url === undefined) {
    return html`<strong>${repo}#${pr}</strong>`;
  }
  const link = html`<strong><a href="${url}">${repo}#${pr}</a></strong>`;
  return html`${link}${affordance === undefined
    ? nothing
    : html`<br /><span class="muted small"
          ><a href="${url}">${affordance}</a></span
        >`}`;
};
