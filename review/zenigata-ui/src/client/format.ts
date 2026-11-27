/**
 * The page's shared rendering vocabulary: the human duration and age
 * forms, the semantic chips, and the renderable type every panel's
 * templates speak.
 */

import { html, nothing, type TemplateResult } from "lit";

/** Any renderable: a template, or lit's nothing. */
export type Renderable = TemplateResult | typeof nothing;

// ---------------------------------------------------------------------------
// Human forms
// ---------------------------------------------------------------------------

export const duration = (seconds: number): string => {
  if (seconds < 1) {
    return "<1s";
  }
  if (seconds < 60) {
    return seconds < 10
      ? `${seconds.toFixed(1).replace(/\.0$/, "")}s`
      : `${Math.floor(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.floor(seconds % 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  return hours % 24 === 0
    ? `${Math.floor(hours / 24)}d`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** A pipeline phase's duration: milliseconds under a second, human above. */
export const phase = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : duration(ms / 1000);

/** How long ago an ISO moment was, as of the render. Title keeps the ISO. */
export const age = (iso: string, nowMs: number): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0
      ? `${hours}h ago`
      : `${hours}h ${minutes % 60}m ago`;
  }
  return hours % 24 === 0
    ? `${Math.floor(hours / 24)}d ago`
    : `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
};

export const stamped = (iso: string, nowMs: number): TemplateResult =>
  html`<span class="muted" title="${iso}">${age(iso, nowMs)}</span>`;

// ---------------------------------------------------------------------------
// Semantic chips
// ---------------------------------------------------------------------------

/**
 * Green is running and healthy, amber is parked or waiting, red is stopped
 * or down, gray is settled and neutral. The word on the chip carries the
 * meaning; the color only speeds the glance.
 */
export type Tone = "ok" | "warn" | "bad" | "mute";

export const chip = (text: string, tone: Tone): TemplateResult =>
  html`<span class="chip ${tone}">${text}</span>`;
