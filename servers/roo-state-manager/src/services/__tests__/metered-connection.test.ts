import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	parseConnectionCost,
	isMeteredCost,
	isMeteredConnection,
	resetMeteredConnectionCache,
	runPowerShellProbe,
	METERED_CHECK_TTL_MS,
	PROBE_SCRIPT,
} from '../metered-connection.js';

// CI runs on Linux, where the execution test below is skipped: this static
// check is the only guard there against a probe edit that breaks the field
// order parseConnectionCost relies on (a broken probe fails open, silently).
describe('PROBE_SCRIPT', () => {
	it('loads the WinRT type and prints the five fields in parse order', () => {
		expect(PROBE_SCRIPT).toContain('ContentType=WindowsRuntime');
		expect(PROBE_SCRIPT).toContain('GetInternetConnectionProfile()');
		expect(PROBE_SCRIPT).toContain('"NONE"');
		expect(PROBE_SCRIPT).toContain(
			'"{0}|{1}|{2}|{3}|{4}" -f $c.NetworkCostType,$c.Roaming,$c.ApproachingDataLimit,$c.OverDataLimit,$p.ProfileName',
		);
	});
});

describe('parseConnectionCost', () => {
	it('reads the probe line, profile names may contain the separator', () => {
		expect(parseConnectionCost('Fixed|False|False|False|Jesse hotspot\r\n')).toEqual({
			costType: 'Fixed', roaming: false, approachingDataLimit: false, overDataLimit: false, profileName: 'Jesse hotspot',
		});
		expect(parseConnectionCost('Unrestricted|True|False|True|a|b').profileName).toBe('a|b');
	});

	it('returns null for no internet profile or foreign output', () => {
		expect(parseConnectionCost('NONE')).toBeNull();
		expect(parseConnectionCost('')).toBeNull();
		expect(parseConnectionCost('some error text')).toBeNull();
	});
});

describe('isMeteredCost', () => {
	const base = { costType: 'Unrestricted', roaming: false, approachingDataLimit: false, overDataLimit: false, profileName: 'x' };
	it('Fixed and Variable are metered, Unrestricted and Unknown are not', () => {
		expect(isMeteredCost({ ...base, costType: 'Fixed' })).toBe(true);
		expect(isMeteredCost({ ...base, costType: 'Variable' })).toBe(true);
		expect(isMeteredCost(base)).toBe(false);
		expect(isMeteredCost({ ...base, costType: 'Unknown' })).toBe(false);
		expect(isMeteredCost(null)).toBe(false);
	});
	it('roaming and data-limit flags are metered on any cost type', () => {
		expect(isMeteredCost({ ...base, roaming: true })).toBe(true);
		expect(isMeteredCost({ ...base, approachingDataLimit: true })).toBe(true);
		expect(isMeteredCost({ ...base, overDataLimit: true })).toBe(true);
	});
});

describe('isMeteredConnection', () => {
	beforeEach(() => resetMeteredConnectionCache());

	const win = (stdout: string, now = () => 0) => {
		const runProbe = vi.fn(async () => stdout);
		return { runProbe, deps: { platform: 'win32' as const, env: {}, now, runProbe } };
	};

	it('pauses on a metered hotspot and allows an unmetered link', async () => {
		expect(await isMeteredConnection(win('Fixed|False|False|False|Jesse hotspot').deps)).toBe(true);
		resetMeteredConnectionCache();
		expect(await isMeteredConnection(win('Unrestricted|False|False|False|Ethernet').deps)).toBe(false);
	});

	it('never probes off Windows or when ROO_INDEXING_ON_METERED=true', async () => {
		const linux = win('Fixed|False|False|False|x');
		expect(await isMeteredConnection({ ...linux.deps, platform: 'linux' })).toBe(false);
		const optIn = win('Fixed|False|False|False|x');
		expect(await isMeteredConnection({ ...optIn.deps, env: { ROO_INDEXING_ON_METERED: ' TRUE ' } })).toBe(false);
		expect(linux.runProbe).not.toHaveBeenCalled();
		expect(optIn.runProbe).not.toHaveBeenCalled();
	});

	it('fails open when the probe errors', async () => {
		const runProbe = vi.fn(async () => { throw new Error('powershell.exe not found'); });
		expect(await isMeteredConnection({ platform: 'win32', env: {}, now: () => 0, runProbe })).toBe(false);
	});

	it('caches the verdict for the TTL, then re-probes', async () => {
		let t = 0;
		const { runProbe, deps } = win('Fixed|False|False|False|x', () => t);
		await isMeteredConnection(deps);
		t = METERED_CHECK_TTL_MS - 1;
		await isMeteredConnection(deps);
		expect(runProbe).toHaveBeenCalledTimes(1);
		t = METERED_CHECK_TTL_MS;
		await isMeteredConnection(deps);
		expect(runProbe).toHaveBeenCalledTimes(2);
	});

	// Executes the production WinRT probe: a broken script would fail open
	// silently in isMeteredConnection, so its raw output is asserted here.
	it.runIf(process.platform === 'win32')('the production probe returns a parseable cost on this host', async () => {
		const out = await runPowerShellProbe();
		if (out.trim() !== 'NONE') expect(parseConnectionCost(out)).not.toBeNull();
	}, 20_000);
});
