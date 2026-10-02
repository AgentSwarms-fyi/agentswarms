// A dialog opened from a menu item mounts while the menu is still closing,
// and the menu's focus trap takes the keyboard back as it goes, leaving it
// on the page: typing then went nowhere. Focus the dialog's field once no
// menu is left (a few frames at most).

export function focusAfterMenu(get: () => HTMLElement | null | undefined, select = false): void {
  let frames = 0;
  const tick = () => {
    const menuOpen = !!document.querySelector('[role="menu"]');
    const el = get();
    if ((menuOpen || !el) && frames++ < 30) {
      requestAnimationFrame(tick);
      return;
    }
    if (!el) return;
    el.focus({ preventScroll: true });
    if (select && el instanceof HTMLInputElement) el.select();
  };
  requestAnimationFrame(tick);
}

/** For a Radix dialog's onOpenAutoFocus: keep Radix from focusing, then focus the field once the menu is gone. */
export function openFocus(get: () => HTMLElement | null | undefined, select = false) {
  return (e: Event) => {
    e.preventDefault();
    focusAfterMenu(get, select);
  };
}
