/**
 * audio-focus.js — one audible thing at a time.
 *
 * Read-aloud and the audiobook player are independent engines, and both take
 * over the Media Session. Nothing stopped them overlapping: starting a book's
 * read-aloud while an audiobook was playing left two voices talking at once,
 * with the lock-screen controls wired to whichever claimed them last.
 *
 * Kept in its own module because the two would otherwise have to import each
 * other.
 */

const owners = new Map(); // id → pause()

/** Register a thing that makes sound, and how to quieten it. */
export const registerAudioOwner = (id, pause) => { owners.set(id, pause); };

/**
 * Take playback for `id`, pausing every other owner. Safe to call on every
 * play — pausing something already paused is a no-op.
 */
export const claimAudio = (id) => {
  for (const [other, pause] of owners) {
    if (other === id) continue;
    try { pause(); } catch (err) { console.warn(`couldn't pause ${other}`, err); }
  }
};
