/**
 * The status page app: renders GET /page's data with lit, polls it on
 * the 30s cadence, consumes the finished-review notifications, and
 * refreshes the open session-log blocks in place (PRJ-547's live log —
 * the poll cadence fetches the expanded block's view from
 * /log/<session id> and re-renders its body).
 *
 * The class is the testable unit: the environment's fetch seams and
 * notification sink are injected, so the suite drives poll() against
 * fakes and the browser runs the same modules bundled.
 */

import { render } from "lit";
import { POLL_MS, type FinishNotifier } from "../notifier.js";
import type { TranscriptView } from "../run-data.js";
import type { PageData } from "../page-feed.js";
import { hydratePage, notifyControl, pageTemplate } from "./page.js";
import { logBody } from "./session-log.js";

/** What the app reaches the world through; injected, never imported. */
export interface PageEnvironment {
  fetchPage(): Promise<PageData>;
  /** Null answers not found — a settled or swept session's block keeps its last state. */
  fetchLog(sessionId: string): Promise<TranscriptView | null>;
  notifier: FinishNotifier;
}

export class StatusPageApp {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The page renders once at boot; polls never re-render it. */
  private rendered = false;

  /**
   * Each open log block's refresh epoch: two fetches can overlap (no
   * browser fetch timeout), and the older response must never land
   * after the newer one.
   */
  private readonly epochs = new WeakMap<Element, number>();

  constructor(
    private readonly container: HTMLElement,
    private readonly env: PageEnvironment,
    private readonly pollMs: number = POLL_MS,
  ) {
    // Re-checking the pin jumps to the tail at once and resumes
    // following with the next swap. The listener is delegated — the
    // checkboxes are rendered once per block, never wired one by one.
    this.container.addEventListener("change", (event) => {
      const box = event.target;
      if (
        !(box instanceof HTMLInputElement) ||
        !box.classList.contains("log-pin-box")
      ) {
        return;
      }
      const block = box.closest("details[data-log-session]");
      if (block === null || !box.checked) {
        return;
      }
      const body = block.querySelector<HTMLElement>(".transcript-body");
      if (body !== null) {
        body.scrollTop = body.scrollHeight;
      }
    });
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One poll: notifications and the open logs' refresh; never a re-render. */
  async poll(): Promise<void> {
    let page: PageData;
    try {
      page = await this.env.fetchPage();
    } catch {
      // A failed poll leaves the page as it is; the next one retries.
      return;
    }
    if (!this.rendered) {
      this.render(page);
      this.rendered = true;
    }
    this.env.notifier.consume(page.runs);
    await this.refreshOpenLogs();
  }

  render(page: PageData): void {
    render(pageTemplate(page), this.container);
    hydratePage(
      page,
      this.container,
      this.env.notifier.state,
      () => void this.enableNotifications(),
    );
  }

  /**
   * The footer control's request: the user gesture the prompt needs.
   * The page itself never re-renders — the control's own span is the
   * render()'s container, so its content is replaced in place, the way
   * the old page's script re-rendered it.
   */
  private async enableNotifications(): Promise<void> {
    await this.env.notifier.enable();
    const control =
      this.container.querySelector<HTMLElement>(".notify-control");
    if (control !== null) {
      render(
        notifyControl(
          this.env.notifier.state,
          () => void this.enableNotifications(),
        ),
        control,
      );
    }
  }

  /**
   * The live session log's refresh (PRJ-547): while a running row's log
   * block stands open, each poll also fetches its view from
   * /log/<session id> and re-renders the block's body in place.
   * Collapsed blocks stay as rendered; a settled or swept session's
   * not-found answer leaves the block as it is. The per-block epoch
   * drops a stale answer.
   */
  private async refreshOpenLogs(): Promise<void> {
    const blocks = this.container.querySelectorAll<HTMLDetailsElement>(
      "details[data-log-session]",
    );
    await Promise.all(
      Array.from(blocks, async (block) => {
        if (block.open !== true) {
          return;
        }
        const sessionId = block.getAttribute("data-log-session");
        if (sessionId === null) {
          return;
        }
        const epoch = (this.epochs.get(block) ?? 0) + 1;
        this.epochs.set(block, epoch);
        let view: TranscriptView | null;
        try {
          view = await this.env.fetchLog(sessionId);
        } catch {
          // A failed refresh leaves the block as it is.
          return;
        }
        if (view === null || this.epochs.get(block) !== epoch) {
          return;
        }
        this.swapLogBody(block, view);
      }),
    );
  }

  /**
   * The block's `.log-body` is the swap point — the summary and the pin
   * control outside it are never recreated, so the pin's checked state
   * survives every swap as natural DOM state. The body div carries no
   * content the shell template laid down, so this `render()` is the
   * content's only owner and replaces in place; a body anything else
   * had rendered into would make this call append a second copy, the
   * duplicated box of PRJ-568.
   *
   * Both scroll modes are the swap's job: a fresh log box starts at
   * scrollTop 0, so a swap that did not set it would snap every reader
   * to the top. Pinned, the new box rides the tail (scrollTop =
   * scrollHeight); unpinned, the old box's scrollTop carries over — the
   * reading line keeps its place for the common case of content
   * appended below. A cap cut removes whole turns at the old end above
   * the reader, and the carried scrollTop then reads a shifted line —
   * the best-effort cost of the simple anchor, accepted rather than
   * reconstructing per-turn offsets the view does not carry. A view
   * with no log box (the gone or unreadable state) swaps in and
   * scrolls nothing.
   */
  private swapLogBody(block: Element, view: TranscriptView): void {
    const body = block.querySelector<HTMLElement>(".log-body");
    if (body === null) {
      return;
    }
    const box = body.querySelector<HTMLElement>(".transcript-body");
    const top = box?.scrollTop ?? 0;
    render(logBody(view), body);
    const fresh = body.querySelector<HTMLElement>(".transcript-body");
    if (fresh === null) {
      return;
    }
    const pin = block.querySelector<HTMLInputElement>(".log-pin-box");
    if (pin !== null && pin.checked) {
      fresh.scrollTop = fresh.scrollHeight;
    } else {
      fresh.scrollTop = top;
    }
  }
}
