// "Add reminder" in the ⌘K switcher: go to Today and focus the quick-add bar.
// The bar may not be mounted yet (you were on another page), so the request
// waits in `pending` until it is.
let pending = false;
const EVENT = 'hub:quick-add-focus';

export function requestQuickAddFocus() {
  pending = true;
  dispatchEvent(new Event(EVENT));
}

/** Called by the quick-add bar: focuses now if a request is waiting, and on every later one. */
export function onQuickAddFocus(focus: () => void): () => void {
  const run = () => {
    if (!pending) return;
    pending = false;
    // After the page has rendered.
    requestAnimationFrame(focus);
  };
  run();
  addEventListener(EVENT, run);
  return () => removeEventListener(EVENT, run);
}
