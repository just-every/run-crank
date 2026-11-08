/** Shared native D1 ceilings used by SQL adapters and selected-key readers. */
export const d1NativeLimits: Readonly<{
  length: number;
  sqlLength: number;
  column: number;
  variableNumber: number;
  functionArg: number;
  likePatternLength: number;
  exprDepth: number;
}>;
