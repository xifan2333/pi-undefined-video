/**
 * Dialog sprite constants shared by render (sprite export) and timeline/video
 * (program-axis state scheduling).
 *
 * Needles = named RGBA PNGs from `generate render -f sprite`.
 * Program states = needles + `hidden` (fully transparent packaging gaps).
 */
export const DIALOG_NEEDLES = ["idle", "talk-closed", "talk-open", "wait-on"] as const;
export type DialogNeedle = (typeof DIALOG_NEEDLES)[number];

/** Program-axis states; `hidden` is not a sprite file. */
export const DIALOG_STATES = ["idle", "talk-closed", "talk-open", "wait-on", "hidden"] as const;
export type DialogState = (typeof DIALOG_STATES)[number];
