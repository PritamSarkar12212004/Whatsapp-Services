/**
 * Pure helpers for the analytics controller.
 *
 * @see analytics.controller.js (imports these)
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Build the last `n` day boundaries as [{ start, end, key }] (oldest first). */
export const lastNDays = (n) => {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    days.push({
      start: d,
      end: new Date(d.getTime() + DAY_MS),
      key: d.toISOString().slice(0, 10),
    });
  }
  return days;
};
