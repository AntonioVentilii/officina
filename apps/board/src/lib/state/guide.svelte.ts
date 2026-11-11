const key = (memberId: string) => `officina.guide.${memberId}`;

/** The welcome guide: shown once per member in each browser, and on demand from the sidebar. */
class GuideState {
  open = $state(false);

  /** Opens the guide the first time this member signs in on this browser. */
  showIfNew(memberId: string) {
    try {
      if (localStorage.getItem(key(memberId))) return;
    } catch {
      // Storage refused (a private window): showing it again next visit is the lesser evil.
    }
    this.open = true;
  }

  close(memberId: string | undefined) {
    this.open = false;
    if (!memberId) return;
    try {
      localStorage.setItem(key(memberId), new Date().toISOString());
    } catch {
      // The guide then shows again on the next visit.
    }
  }
}

export const guide = new GuideState();
