/**
 * Metered-connection guard for background indexing.
 *
 * Third bandwidth leak (26/10): a laptop on a phone hotspot (Orange mobile,
 * 92.184.x.x in the IIS logs of po-2023) ran Worker B over the billed link —
 * 644 MB of Qdrant upserts and 232 MB of embeddings between 09:09Z and 10:59Z.
 * The `ROO_INDEXING_ENABLED` kill-switch (#985) is read once at boot and set by
 * hand per machine, so it cannot follow a machine that moves from fibre to a
 * hotspot. This probe asks Windows for the cost of the current internet profile
 * (WinRT `NetworkInformation`, the same signal Windows Update and OneDrive obey)
 * so Worker B pauses while the link is metered and resumes when it is not.
 *
 * Fail-open: a probe that cannot answer leaves indexing on, as before this guard
 * existed — a broken probe must not silently stop indexing on every machine.
 */
import { execFile } from 'child_process';

export interface ConnectionCost {
	costType: string;
	roaming: boolean;
	approachingDataLimit: boolean;
	overDataLimit: boolean;
	profileName: string;
}

/** Re-probe at most once per Worker B tick (the tick is 5 min). */
export const METERED_CHECK_TTL_MS = 4 * 60 * 1000;

// Windows PowerShell 5.1 only: the WinRT type accelerator does not exist in pwsh 7.
export const PROBE_SCRIPT = [
	'$null=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]',
	'$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
	'if(-not $p){"NONE"}else{$c=$p.GetConnectionCost();"{0}|{1}|{2}|{3}|{4}" -f $c.NetworkCostType,$c.Roaming,$c.ApproachingDataLimit,$c.OverDataLimit,$p.ProfileName}',
].join(';');

/**
 * Parses the probe's last output line, `Cost|Roaming|Approaching|Over|Profile`.
 * `null` = no internet profile, or output that is not the probe's format.
 */
export function parseConnectionCost(stdout: string): ConnectionCost | null {
	const line = stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
	const parts = line.split('|');
	if (parts.length < 5 || !parts[0]) return null;
	const flag = (v: string) => v.trim().toLowerCase() === 'true';
	return {
		costType: parts[0].trim(),
		roaming: flag(parts[1]),
		approachingDataLimit: flag(parts[2]),
		overDataLimit: flag(parts[3]),
		profileName: parts.slice(4).join('|').trim(),
	};
}

/**
 * `Fixed` and `Variable` are billed by volume; roaming and data-limit flags are too.
 * `Unknown` stays unmetered on purpose: a desktop seat answering Unknown would
 * otherwise stop indexing fleet-wide, silently, while every link is fibre.
 */
export function isMeteredCost(cost: ConnectionCost | null): boolean {
	if (!cost) return false;
	return cost.costType === 'Fixed'
		|| cost.costType === 'Variable'
		|| cost.roaming
		|| cost.approachingDataLimit
		|| cost.overDataLimit;
}

export interface MeteredProbeDeps {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	now: () => number;
	runProbe: () => Promise<string>;
}

/** The production probe: raw stdout of the WinRT cost query (Windows only). */
export function runPowerShellProbe(): Promise<string> {
	return new Promise((resolveOut, reject) => {
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT],
			{ timeout: 15_000, windowsHide: true },
			(err, stdout) => (err ? reject(err) : resolveOut(String(stdout))),
		);
	});
}

let cache: { at: number; metered: boolean } | null = null;

/** Test hook: forget the cached verdict. */
export function resetMeteredConnectionCache(): void {
	cache = null;
}

/**
 * True while Windows reports the internet profile as metered. Always false off
 * Windows, and when `ROO_INDEXING_ON_METERED=true` opts the machine back in.
 */
export async function isMeteredConnection(deps: Partial<MeteredProbeDeps> = {}): Promise<boolean> {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const runProbe = deps.runProbe ?? runPowerShellProbe;

	if ((env.ROO_INDEXING_ON_METERED ?? '').trim().toLowerCase() === 'true') return false;
	if (platform !== 'win32') return false;
	if (cache && now() - cache.at < METERED_CHECK_TTL_MS) return cache.metered;

	let metered = false;
	let cost: ConnectionCost | null = null;
	try {
		cost = parseConnectionCost(await runProbe());
		metered = isMeteredCost(cost);
	} catch (error: any) {
		console.warn(`[Metered-Guard] Connection cost probe failed — indexing stays on (fail-open): ${error?.message || error}`);
	}
	if (cache?.metered !== metered) {
		console.log(metered
			? `📵 [Metered-Guard] Metered connection (${cost?.costType}, profile "${cost?.profileName}") — background indexing paused`
			: `[Metered-Guard] Unmetered connection${cost ? ` (${cost.costType}, profile "${cost.profileName}")` : ''} — background indexing allowed`);
	}
	cache = { at: now(), metered };
	return metered;
}
