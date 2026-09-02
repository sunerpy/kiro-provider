import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PlatformPathOptions = {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly platform?: NodeJS.Platform | string;
	readonly homeDirectory?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Per-user configuration root shared by every kiro-provider store.
 *
 * POSIX: `$XDG_CONFIG_HOME` or `~/.config`.
 * Windows: `%APPDATA%` or `~\AppData\Roaming`.
 *
 * An empty environment value is treated as unset.
 */
export function platformConfigRoot(options: PlatformPathOptions = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDirectory = options.homeDirectory ?? homedir();
	return platform === "win32"
		? (nonEmpty(env.APPDATA) ?? join(homeDirectory, "AppData", "Roaming"))
		: (nonEmpty(env.XDG_CONFIG_HOME) ?? join(homeDirectory, ".config"));
}

/**
 * The pre-0.6 configuration root that ignored the platform and always used
 * `$XDG_CONFIG_HOME` / `~/.config`. Kept only so Windows users whose
 * `config.json` still lives there keep working.
 */
export function legacyConfigRoot(options: PlatformPathOptions = {}): string {
	const env = options.env ?? process.env;
	const homeDirectory = options.homeDirectory ?? homedir();
	return nonEmpty(env.XDG_CONFIG_HOME) ?? join(homeDirectory, ".config");
}

export type DefaultConfigPathOptions = PlatformPathOptions & {
	readonly exists?: (path: string) => boolean;
};

/**
 * Default `config.json` location.
 *
 * On win32 the platform root (`%APPDATA%\kiro-provider\config.json`) is
 * preferred; when that file does not exist but the legacy
 * `~/.config/kiro-provider/config.json` does, the legacy path is returned so
 * existing installations are not silently reconfigured.
 */
export function defaultConfigPath(options: DefaultConfigPathOptions = {}): string {
	const exists = options.exists ?? existsSync;
	const preferred = join(platformConfigRoot(options), "kiro-provider", "config.json");
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return preferred;
	const legacy = join(legacyConfigRoot(options), "kiro-provider", "config.json");
	if (legacy !== preferred && !exists(preferred) && exists(legacy)) return legacy;
	return preferred;
}
