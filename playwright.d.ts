import type { BrowserContext, Frame, Locator, Page } from 'playwright-core';

export interface InstallReport {
  version: string;
  /** Frames that got the script now. */
  injected: number;
  /** Frames that already had it. */
  present: number;
  mismatched: { url: string; version: string }[];
  failed: { url: string; error: string }[];
}

/** Adds the helper as an init script and injects it into documents that are already open. */
export function install(target: BrowserContext | Page, opts?: { existing?: boolean }): Promise<InstallReport>;

export type UploadFiles = Parameters<Locator['setInputFiles']>[0];

export interface UploadOptions {
  /** The file input itself (a Locator or CSS selector). */
  input?: Locator | string;
  /** What to click to get a file input: a Locator, or a button/link/label name. */
  trigger?: Locator | string | RegExp;
  /** Search in this frame instead of the main frame. */
  frame?: Frame;
  /** Per step, in ms (default 5000). */
  timeout?: number;
}

export function uploadFile(page: Page, files: UploadFiles, opts?: UploadOptions): Promise<{ ok: true; via: 'input' | 'filechooser'; files: string[] }>;

export class UploadError extends Error {
  code: 'NO_TARGET' | 'AMBIGUOUS_TARGET' | 'TIMEOUT' | 'NOT_APPLIED';
}

export const DEFAULT_TRIGGER: RegExp;
