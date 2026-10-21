/** Absolute path of the page-side script, for `addInitScript({ path })`. */
export const helperPath: string;
/** Source of the page-side script, for channels that take a string. */
export const helperSource: string;
/** Name of the global the script defines: `"__aph__"`. */
export const globalName: '__aph__';
export const version: string;

export type ErrorCode =
  | 'BAD_REF' | 'WRONG_DOCUMENT' | 'STALE_REF' | 'BAD_ARGUMENT'
  | 'DISABLED' | 'READONLY' | 'NOT_VISIBLE' | 'OCCLUDED'
  | 'UNSUPPORTED_CONTROL' | 'VALUE_REJECTED' | 'OPTION_NOT_FOUND' | 'NO_EFFECT';

export interface Failure {
  ok: false;
  error: { code: ErrorCode; message: string; coveredBy?: string; coveredByRef?: string; options?: string[]; value?: string };
}
export type Result<T = {}> = ({ ok: true; ref: string } & T) | Failure;

export type Hit = 'clear' | 'covered' | 'offscreen' | 'unknown';

export interface SnapshotElement {
  ref: string;
  role: string | null;
  name: string;
  /** Only for elements without a role (e.g. a clickable div). */
  tag?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  pressed?: boolean;
  selected?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  invalid?: boolean;
  href?: string;
  /** Frame index (see `frames`); absent for the top document. */
  frame?: number;
  hit?: Hit;
  coveredBy?: string;
  coveredByRef?: string;
}

export interface FrameInfo {
  index: number;
  parent: number;
  depth: number;
  name: string;
  url: string;
  access: 'same-origin' | 'cross-origin' | 'unavailable';
  ref: string;
}

export interface Snapshot {
  url: string;
  title: string;
  untrusted: true;
  elements: SnapshotElement[];
  headings: { level: number; text: string; frame?: number }[];
  live: { role: string; text: string; frame?: number }[];
  frames: FrameInfo[];
  text: string;
  stats: { found: number; listed: number; headingsOmitted: number; ms: number };
}

export interface SnapshotOptions {
  /** Default 100. Elements in or near the viewport are kept first. */
  maxElements?: number;
  /** A ref or CSS selector to limit the snapshot to one subtree. */
  root?: string;
  /** Characters of main text to include (default 400, 0 to omit). */
  textChars?: number;
  /** Set to false to skip same-origin frames. */
  frames?: boolean;
  /** Set to false to skip hit testing. */
  occlusion?: boolean;
  /** Text format only: append link targets. */
  hrefs?: boolean;
}

export interface FormState {
  ref: string;
  name: string;
  action?: string;
  frame?: number;
  fields: Record<string, string | boolean | (string | boolean)[]>;
}

export interface FoundElement { ref: string; role: string | null; name: string; tag?: string; interactive?: boolean; frame?: number }

export interface PageHelper {
  version: string;
  /** Per-page-load ref prefix: four random letters. Refs are this prefix plus a number. */
  doc: string;
  snapshot(opts: SnapshotOptions & { format: 'text' }): string;
  snapshot(opts?: SnapshotOptions & { format?: 'json' }): Snapshot;
  find(text: string, opts?: { exact?: boolean; role?: string; limit?: number; interactiveOnly?: boolean }): FoundElement[];
  query(selector: string, opts?: { limit?: number; visibleOnly?: boolean }): FoundElement[];
  inspect(ref: string): Result<Record<string, unknown>>;
  click(ref: string, opts?: { force?: boolean }): Result;
  fill(ref: string, text: string, opts?: { blur?: boolean; force?: boolean }): Result<{ value: string }>;
  select(ref: string, values: string | string[], opts?: { blur?: boolean; force?: boolean }): Result<{ value: string }>;
  setChecked(ref: string, checked?: boolean, opts?: { force?: boolean }): Promise<Result<{ checked: boolean; changed: boolean }>>;
  focus(ref: string): Result<{ focused: boolean }>;
  scrollIntoView(ref: string, opts?: { block?: 'start' | 'center' | 'end' | 'nearest' }): Result;
  errors(): { kind: 'constraint' | 'aria-invalid' | 'message'; ref: string; field?: string; message: string; userInvalid?: boolean; frame?: number }[];
  /** With a ref as `target`, returns a Failure if the ref does not resolve. */
  formState(target?: string, opts?: { includeHidden?: boolean }): FormState[] | Failure;
  frames(): FrameInfo[];
  capturePopups(mode?: 'record' | 'same-tab' | 'block' | 'off'): { ok: true; mode: string };
  popups(opts?: { clear?: boolean }): { url: string; target: string; via: 'window.open' | 'link'; mode: string; ts: number }[];
  waitStable(opts?: { quiet?: number; timeout?: number }): Promise<{ ok: true; stable: boolean; waited: number }>;
  dispose(): { ok: true };
}

declare global {
  interface Window {
    __aph__: PageHelper;
  }
}
