/**
 * What an attention label shows, for names a provider may send: each input and the visible text left
 * once control and format characters are taken out and whitespace is collapsed ("" = nothing left).
 *
 * MIRRORED byte for byte in `packages/workshop-backend/__tests__/` (the host's
 * `cleanAttentionLabel` is held to it) and `packages/gatekeeper-inferlabops/__tests__/` (the
 * InferLab gatekeeper's `visibleName`, so a name the host would show as nothing is an unreadable
 * answer there). Change both copies together.
 */
export const ATTENTION_LABEL_CASES: ReadonlyArray<readonly [input: string, visible: string]> = [
  ["Main yard", "Main yard"],
  ["  Main\tyard\n", "Main yard"],
  ["　Field depot ", "Field depot"],
  ["Yard​ 2", "Yard 2"],
  ["a‍b", "ab"],
  ["", ""],
  ["   ", ""],
  ["\t\n\r", ""],
  ["\u0000\u0007", ""],
  ["\u0085 \u007f", ""],
  ["​", ""],
  ["‌‍", ""],
  ["⁠", ""],
  ["﻿", ""],
  ["­", ""],
  ["؜", ""],
  ["‎‏", ""],
  ["‪‮‬", ""],
  ["⁦⁩", ""],
  ["\u{1d173}\u{1d17a}", ""],
  ["\u{e0001}\u{e0041}", ""],
  ["​ 　\u0000﻿", ""],
];
