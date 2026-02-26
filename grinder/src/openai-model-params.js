const KNOWN_MODEL_FAMILIES = [
	'gpt-5-mini',
	'gpt-5-nano',
	'gpt-5.2',
	'gpt-5.1',
	'gpt-5',
	'gpt-4.1-mini',
	'gpt-4.1-nano',
	'gpt-4.1',
	'gpt-4o-mini',
	'gpt-4o',
]

const RESPONSES_TEMPERATURE_UNSUPPORTED = new Set([
	'gpt-5-mini',
	'gpt-5-nano',
	'gpt-5',
])

const RESPONSES_TEMPERATURE_REQUIRES_REASONING_NONE = new Set([
	'gpt-5.2',
])

const REASONING_EFFORTS_BY_FAMILY = {
	'gpt-5': ['minimal', 'low', 'medium', 'high'],
	'gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
	'gpt-5-nano': ['minimal', 'low', 'medium', 'high'],
	'gpt-5.1': ['none', 'low', 'medium', 'high'],
	'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSnapshotOfFamily(model, family) {
	let re = new RegExp(`^${escapeRegExp(family)}-\\d{4}-\\d{2}-\\d{2}$`)
	return re.test(model)
}

function normalize(model) {
	return String(model || '').trim().toLowerCase()
}

export function normalizeKnownModelFamily(model) {
	let m = normalize(model)
	if (!m) return ''
	for (let family of KNOWN_MODEL_FAMILIES) {
		if (m === family || isSnapshotOfFamily(m, family)) return family
	}
	return ''
}

export function resolveResponsesTemperatureConfig(model, temperature) {
	let family = normalizeKnownModelFamily(model)
	if (temperature === undefined) {
		return {
			family,
			mode: 'unset',
			temperature: undefined,
			reasoning: undefined,
		}
	}

	if (RESPONSES_TEMPERATURE_UNSUPPORTED.has(family)) {
		return {
			family,
			mode: 'unsupported',
			temperature: undefined,
			reasoning: undefined,
		}
	}

	if (RESPONSES_TEMPERATURE_REQUIRES_REASONING_NONE.has(family)) {
		return {
			family,
			mode: 'reasoning_none',
			temperature,
			reasoning: { effort: 'none' },
		}
	}

	return {
		family,
		mode: 'supported',
		temperature,
		reasoning: undefined,
	}
}

export function resolveChatCompletionsTemperature(model, temperature) {
	if (temperature === undefined) return undefined
	let family = normalizeKnownModelFamily(model)
	if (family && family.startsWith('gpt-5')) return undefined
	return temperature
}

export function supportsReasoningEffort(model) {
	let family = normalizeKnownModelFamily(model)
	let allowed = REASONING_EFFORTS_BY_FAMILY[family]
	return Array.isArray(allowed) && allowed.length > 0
}

export function resolveReasoningEffort(model, preferred = 'low') {
	let family = normalizeKnownModelFamily(model)
	let allowed = REASONING_EFFORTS_BY_FAMILY[family]
	if (!Array.isArray(allowed) || !allowed.length) return undefined

	let requested = String(preferred || '').trim().toLowerCase()
	if (requested && allowed.includes(requested)) return requested
	if (allowed.includes('low')) return 'low'
	return allowed[0]
}
