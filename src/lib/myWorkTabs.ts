// The tabs of My work, in the order they are shown. Kept apart from the page
// so a link to one of them (and the test that such a link lands) does not
// import the page.
export const MY_WORK_TABS = ["recent", "favourites", "shared"] as const;
export type MyWorkTab = (typeof MY_WORK_TABS)[number];

/** The tab an address asks for; anything else is the first one. */
export function myWorkTabFrom(value: unknown): MyWorkTab {
  return MY_WORK_TABS.includes(value as MyWorkTab) ? (value as MyWorkTab) : MY_WORK_TABS[0];
}
