// #4819 parity fixture — deterministic, never edit: goldens freeze this behavior.
export interface Widget {
	id: string
	name: string
}

export class WidgetFactory {
	private cache: Map<string, Widget> = new Map()

	make(id: string, name: string): Widget {
		const w: Widget = { id, name }
		this.cache.set(id, w)
		return w
	}

	// Oversized body: pushes this method_definition past
	// MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR (1000 * 1.15), forcing the
	// leaf-chunking-by-lines path with re-balancing across several chunks.
	bigReport(): string {
		const lines: string[] = []
		lines.push("====== WidgetFactory quarterly report — generated section header ======")
		lines.push("cache size            : " + String(this.cache.size).padStart(6, "0") + " entries")
		lines.push("widgets manufactured  : " + String(this.cache.size * 3).padStart(6, "0") + " units")
		lines.push("defect rate           : 0.0012 % (rolling thirty-day window, fleet-wide)")
		lines.push("mean assembly time    : 14.7 ms per widget, p99 at 41.2 ms this quarter")
		lines.push("top model by volume   : frognano-4b (mini tier, fan-out extraction)")
		lines.push("second model          : glm-5.3 (medium tier, coordination summaries)")
		lines.push("energy per widget     : 0.83 Wh measured on the hub, down from 0.91 Wh")
		lines.push("spare parts inventory : 1,204 screws, 88 brackets, 12 crates of padding")
		lines.push("notes                 : this line exists to add bulk to the chunk budget")
		lines.push("notes continued       : parity fixtures need realistic size distribution")
		lines.push("audit trail           : every line here is hashed into segment previews")
		lines.push("closing line          : end of the generated section, tally follows")
		lines.push("tally                 : 13 lines of report content before this one here")
		return lines.join("\n")
	}
}

export function assemble(parts: string[]): string {
	return parts.join("-")
}

export const VERSION = "1.0.0"

function tiny() {
	return 1
}
