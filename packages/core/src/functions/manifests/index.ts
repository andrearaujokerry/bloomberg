// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/core/src/functions/manifests/*.ts (minus index.ts)
// One module per catalogue function manifest (ARCHITECTURE §3.1, BRIEF §6).
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import type { ParamsOf as ParamsOfManifest, PayloadOf as PayloadOfManifest } from '../manifest.js';
import { FunctionRegistry } from '../registry.js';

import { BTMM } from './BTMM.js';
import { CACS } from './CACS.js';
import { CF } from './CF.js';
import { CN } from './CN.js';
import { CRVF } from './CRVF.js';
import { CRYP } from './CRYP.js';
import { DES } from './DES.js';
import { ECO } from './ECO.js';
import { EE } from './EE.js';
import { EQS } from './EQS.js';
import { FA } from './FA.js';
import { FED } from './FED.js';
import { FXC } from './FXC.js';
import { GC } from './GC.js';
import { GIP } from './GIP.js';
import { GP } from './GP.js';
import { HDS } from './HDS.js';
import { HELP } from './HELP.js';
import { HP } from './HP.js';
import { MEMB } from './MEMB.js';
import { MSG } from './MSG.js';
import { N } from './N.js';
import { NI } from './NI.js';
import { OMON } from './OMON.js';
import { OVML } from './OVML.js';
import { PORT } from './PORT.js';
import { Q } from './Q.js';
import { QM } from './QM.js';
import { RV } from './RV.js';
import { SECF } from './SECF.js';
import { SRCH } from './SRCH.js';
import { SWPM } from './SWPM.js';
import { TOP } from './TOP.js';
import { W } from './W.js';
import { WB } from './WB.js';
import { WEI } from './WEI.js';
import { WIRP } from './WIRP.js';
import { YAS } from './YAS.js';

export {
  BTMM,
  CACS,
  CF,
  CN,
  CRVF,
  CRYP,
  DES,
  ECO,
  EE,
  EQS,
  FA,
  FED,
  FXC,
  GC,
  GIP,
  GP,
  HDS,
  HELP,
  HP,
  MEMB,
  MSG,
  N,
  NI,
  OMON,
  OVML,
  PORT,
  Q,
  QM,
  RV,
  SECF,
  SRCH,
  SWPM,
  TOP,
  W,
  WB,
  WEI,
  WIRP,
  YAS,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const manifestModules = {
  BTMM,
  CACS,
  CF,
  CN,
  CRVF,
  CRYP,
  DES,
  ECO,
  EE,
  EQS,
  FA,
  FED,
  FXC,
  GC,
  GIP,
  GP,
  HDS,
  HELP,
  HP,
  MEMB,
  MSG,
  N,
  NI,
  OMON,
  OVML,
  PORT,
  Q,
  QM,
  RV,
  SECF,
  SRCH,
  SWPM,
  TOP,
  W,
  WB,
  WEI,
  WIRP,
  YAS,
} as const;

/** Canonical code → manifest (FUNCTIONS.md L524). Aliases are not keys; `registry` resolves those. */
export const manifests = manifestModules;

/** 'DES' | 'GP' | … — canonical codes only (FUNCTIONS.md L525). */
export type FunctionCode = keyof typeof manifests;

/** The payload variant union of one function code (FUNCTIONS.md L526). */
export type PayloadOf<C extends FunctionCode> = PayloadOfManifest<(typeof manifests)[C]>;

/** The parsed parameter object of one function code (FUNCTIONS.md L527). */
export type ParamsOf<C extends FunctionCode> = ParamsOfManifest<(typeof manifests)[C]>;

/** The one catalogue every side shares (FUNCTIONS.md L528). */
export const registry = new FunctionRegistry(Object.values(manifests));
