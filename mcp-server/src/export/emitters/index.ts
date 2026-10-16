import type { Emitter } from './common.js';
import { playwrightDotnet } from './playwright-dotnet.js';
import { playwrightTs } from './playwright-ts.js';

export type { EmitInput, EmittedFile, Emitter } from './common.js';

/** Emitters that ship with Tessa. cypress-ts and selenium targets come later. */
export const EMITTERS: Record<string, Emitter> = {
  [playwrightTs.target]: playwrightTs,
  [playwrightDotnet.target]: playwrightDotnet,
};
