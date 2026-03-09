import { log } from './log.js'

export function sleep(ms, reason = '') {
	if (ms <= 0) return
	if (ms >= 1e3) {
		let exactMs = Math.round(ms)
		let approxSec = (ms / 1e3).toFixed()
		let suffix = reason ? ` reason=${String(reason).trim()}` : ''
		log(`resting ${exactMs}ms (~${approxSec}s)...${suffix}`)
	}
	return new Promise(resolve => setTimeout(resolve, ms))
}
