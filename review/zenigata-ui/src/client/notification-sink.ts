/**
 * The browser's own Notification API, wrapped behind the notifier's
 * seam. Permission is requested through the page's own control in the
 * footer — browsers require a user gesture for the prompt — and a
 * declined grant changes nothing: the page keeps working, silently.
 * The tag carries the finish's id, so a repeat poll never doubles where
 * the browser does coalesce by tag.
 */

import type { FinishNotice, NotificationSink } from "../notifier.js";

/** The Notification constructor's window surface, typed loosely. */
interface NotificationGlobal {
  new (title: string, options?: { body?: string; tag?: string }): unknown;
  permission: "granted" | "denied" | "default";
  requestPermission(
    callback?: (state: "granted" | "denied" | "default") => void,
  ): Promise<"granted" | "denied" | "default"> | undefined;
}

const notificationGlobal = (): NotificationGlobal | undefined => {
  const candidate = (globalThis as { Notification?: NotificationGlobal })
    .Notification;
  return typeof candidate === "function" ? candidate : undefined;
};

export class BrowserNotificationSink implements NotificationSink {
  supported(): boolean {
    return notificationGlobal() !== undefined;
  }

  permission(): "granted" | "denied" | "default" {
    const Notification = notificationGlobal();
    return Notification?.permission ?? "default";
  }

  async request(): Promise<"granted" | "denied" | "default"> {
    const Notification = notificationGlobal();
    if (Notification === undefined) {
      return "default";
    }
    const request = Notification.requestPermission();
    if (request && typeof request.then === "function") {
      return request;
    }
    // The callback dialect some browsers still speak: wrap it.
    return new Promise((resolve) => {
      Notification.requestPermission((state) => resolve(state));
    });
  }

  deliver(notice: FinishNotice): boolean {
    try {
      const Notification = notificationGlobal();
      if (Notification === undefined) {
        return false;
      }
      new Notification(notice.title, { body: notice.body, tag: notice.id });
      return true;
    } catch {
      // The constructor failed, so the finish is not consumed: the next
      // poll diffs it again and retries — quiet and cheap — and the
      // finish still lands when the browser recovers.
      return false;
    }
  }
}
