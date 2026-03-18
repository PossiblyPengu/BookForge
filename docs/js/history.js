/**
 * history.js
 *
 * Simple undo/redo stack for application state snapshots.
 * Stores lightweight snapshots (chapter names + order, form field values).
 */

const MAX_HISTORY = 50;

let undoStack = [];
let redoStack = [];
let lastSnapshot = null;

/**
 * Take a snapshot of the current state.
 * @param {Function} getState - Returns a serializable state object
 */
export const pushState = (getState) => {
  const snap = JSON.stringify(getState());
  // Don't push if identical to last snapshot
  if (snap === lastSnapshot) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  lastSnapshot = snap;
};

/**
 * Undo the last state change.
 * @param {Function} getState - Returns current state
 * @param {Function} applyState - Applies a state object
 * @returns {boolean} true if undo was performed
 */
export const undo = (getState, applyState) => {
  if (!undoStack.length) return false;
  const currentSnap = JSON.stringify(getState());
  redoStack.push(currentSnap);
  const prev = undoStack.pop();
  lastSnapshot = prev;
  applyState(JSON.parse(prev));
  return true;
};

/**
 * Redo the last undone state change.
 * @param {Function} getState - Returns current state
 * @param {Function} applyState - Applies a state object
 * @returns {boolean} true if redo was performed
 */
export const redo = (getState, applyState) => {
  if (!redoStack.length) return false;
  const currentSnap = JSON.stringify(getState());
  undoStack.push(currentSnap);
  const next = redoStack.pop();
  lastSnapshot = next;
  applyState(JSON.parse(next));
  return true;
};

/**
 * Clear undo/redo history.
 */
export const clearHistory = () => {
  undoStack = [];
  redoStack = [];
  lastSnapshot = null;
};

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
