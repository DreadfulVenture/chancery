/**
 * The page's boot: mount the app onto #app and run the poll loop. The
 * same modules the bundle carries are the modules the tests import —
 * there is no served source string anywhere in the stack.
 */

import { FinishNotifier, localStorageSeenStore } from "../notifier.js";
import type { TranscriptView } from "../run-data.js";
import type { PageData } from "../page-feed.js";
import { BrowserNotificationSink } from "./notification-sink.js";
import { StatusPageApp } from "./app.js";

const boot = (): void => {
  const container = document.getElementById("app");
  if (container === null) {
    return;
  }
  const store = localStorageSeenStore(window.localStorage);
  const sink = new BrowserNotificationSink();
  const notifier = new FinishNotifier(store, sink);
  const app = new StatusPageApp(container, {
    fetchPage: async () => {
      const response = await fetch("/page", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`the page feed answered ${response.status}`);
      }
      return (await response.json()) as PageData;
    },
    fetchLog: async (sessionId) => {
      const response = await fetch(`/log/${encodeURIComponent(sessionId)}`);
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as TranscriptView;
    },
    notifier,
  });
  app.start();
};

boot();
