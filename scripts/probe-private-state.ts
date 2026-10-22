import { platformConfigRoot } from "../src/config/paths.js";

/** Redirect every provider platform root without changing the inherited HOME. */
export function privateProbeStateEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  configRoot: string,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    XDG_CONFIG_HOME: configRoot,
    APPDATA: configRoot,
  };
}

/** Exercise the actual provider resolver, including Windows while running on Linux. */
export function privateProbeStateIsolated(
  env: Readonly<Record<string, string | undefined>>,
  configRoot: string,
): boolean {
  return ["linux", "win32"].every(
    (platform) => platformConfigRoot({ env, platform, homeDirectory: configRoot }) === configRoot,
  );
}
