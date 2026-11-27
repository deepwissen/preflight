/** Point os.homedir() at a fake home for the duration of a test. POSIX reads HOME,
 *  Windows reads USERPROFILE — set both. Returns a restore function. */
export function fakeHome(home: string): () => void {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const k of ["HOME", "USERPROFILE"] as const) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}
