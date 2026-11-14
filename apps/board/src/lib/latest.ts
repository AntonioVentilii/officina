/**
 * For loads that can overlap, of which only the latest may land: each call starts a load and
 * returns a check that turns true once a newer one has started, so a slow answer is dropped instead
 * of replacing a newer one.
 */
export const latestOnly = () => {
  let generation = 0;
  return () => {
    const mine = ++generation;
    return () => mine !== generation;
  };
};
