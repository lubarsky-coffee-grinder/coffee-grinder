const WEB_SEARCH_CALL_USD = 0.01

const MODEL_PRICING_PER_MILLION = {
	'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14.0 },
	'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
	'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
	'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
	'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
}

const PRICED_MODEL_FAMILIES = [
	'gpt-5-mini',
	'gpt-5.2',
	'gpt-4.1-mini',
	'gpt-4.1',
	'gpt-4o-mini',
]

let runTotalUsd = 0
let runApiStats = {}

function toNumber(v) {
	let n = Number(v)
	return Number.isFinite(n) && n >= 0 ? n : 0
}

function resolveModelFamily(model) {
	let m = String(model || '').trim().toLowerCase()
	if (!m) return ''
	for (let family of PRICED_MODEL_FAMILIES) {
		if (m === family || m.startsWith(`${family}-`)) return family
	}
	return ''
}

function extractUsageTokens(usage) {
	let input = toNumber(usage?.prompt_tokens)
	if (!input) input = toNumber(usage?.input_tokens)
	if (!input) input = toNumber(usage?.total_input_tokens)
	if (!input) input = toNumber(usage?.input_tokens_details?.total_tokens)

	let output = toNumber(usage?.completion_tokens)
	if (!output) output = toNumber(usage?.output_tokens)
	if (!output) output = toNumber(usage?.total_output_tokens)
	if (!output) output = toNumber(usage?.output_tokens_details?.total_tokens)

	let cachedInput = toNumber(usage?.prompt_tokens_details?.cached_tokens)
	if (!cachedInput) cachedInput = toNumber(usage?.input_tokens_details?.cached_tokens)
	if (!cachedInput) cachedInput = toNumber(usage?.cached_tokens)
	if (cachedInput > input) cachedInput = input

	return { input, output, cachedInput }
}

function countWebSearchCalls(response) {
	let calls = 0
	let output = Array.isArray(response?.output) ? response.output : []
	for (let item of output) {
		let type = String(item?.type || '').toLowerCase()
		if (type.includes('web_search')) calls++

		let content = Array.isArray(item?.content) ? item.content : []
		for (let part of content) {
			let partType = String(part?.type || '').toLowerCase()
			if (partType.includes('web_search')) calls++
		}
	}
	return calls
}

export function estimateAndLogCost({
	task,
	model,
	usage,
	response,
	fallbackWebSearchCalls = 0,
	logger = console.log,
}) {
	let family = resolveModelFamily(model)
	let pricing = MODEL_PRICING_PER_MILLION[family]
	let tokens = extractUsageTokens(usage || {})
	let webSearchCalls = countWebSearchCalls(response)
	let assumedWebSearchCalls = false
	if (!webSearchCalls && fallbackWebSearchCalls > 0) {
		webSearchCalls = fallbackWebSearchCalls
		assumedWebSearchCalls = true
	}

	let usd = 0
	if (pricing) {
		let uncachedInput = Math.max(0, tokens.input - tokens.cachedInput)
		usd += uncachedInput / 1e6 * pricing.input
		usd += tokens.cachedInput / 1e6 * pricing.cachedInput
		usd += tokens.output / 1e6 * pricing.output
	}
	usd += webSearchCalls * WEB_SEARCH_CALL_USD

	if (!usd) return 0

	runTotalUsd += usd
	let priceModel = family || 'unknown'
	let assumed = assumedWebSearchCalls ? 'yes' : 'no'
	logger(
		`COST task=${task || 'unknown'}`,
		`model=${model || ''}`,
		`price_model=${priceModel}`,
		`input=${tokens.input}`,
		`cached_input=${tokens.cachedInput}`,
		`output=${tokens.output}`,
		`web_search_calls=${webSearchCalls}`,
		`web_search_assumed=${assumed}`,
		`usd=${usd.toFixed(5)}`,
		`run_total_usd=${runTotalUsd.toFixed(5)}`,
	)
	return usd
}

export function getRunTotalUsd() {
	return runTotalUsd
}

export function logRunTotalCost({ task = 'run', logger = console.log } = {}) {
	logger(`COST_TOTAL task=${task} run_total_usd=${runTotalUsd.toFixed(5)}`)
	return runTotalUsd
}

function ensureApiStat(api) {
	let key = String(api || '').trim().toLowerCase()
	if (!key) return
	if (!runApiStats[key]) {
		runApiStats[key] = {
			requests: 0,
			success: 0,
			failed: 0,
			timeout: 0,
		}
	}
	return runApiStats[key]
}

export function trackApiRequest(api, count = 1) {
	let stat = ensureApiStat(api)
	if (!stat) return
	stat.requests += Math.max(0, toNumber(count))
}

export function trackApiResult(api, status, count = 1) {
	let stat = ensureApiStat(api)
	if (!stat) return
	let qty = Math.max(0, toNumber(count))
	if (!qty) return
	let key = String(status || '').trim().toLowerCase()
	if (key === 'success') {
		stat.success += qty
		return
	}
	if (key === 'timeout') {
		stat.timeout += qty
		stat.failed += qty
		return
	}
	stat.failed += qty
}

export function getRunApiStats() {
	return JSON.parse(JSON.stringify(runApiStats))
}

export function logRunApiStats({ task = 'run', logger = console.log } = {}) {
	let snapshots = getRunApiStats()
	let apis = Object.keys(snapshots).sort()
	if (!apis.length) {
		logger(`API_STATS task=${task} requests_total=0`)
		return { requestsTotal: 0, byApi: snapshots }
	}

	let requestsTotal = 0
	let parts = []
	for (let api of apis) {
		let stat = snapshots[api]
		let requests = toNumber(stat?.requests)
		let success = toNumber(stat?.success)
		let failed = toNumber(stat?.failed)
		let timeout = toNumber(stat?.timeout)

		requestsTotal += requests
		parts.push(
			`${api}_requests=${requests}`,
			`${api}_success=${success}`,
			`${api}_failed=${failed}`,
			`${api}_timeout=${timeout}`,
		)
	}

	logger(`API_STATS task=${task}`, ...parts, `requests_total=${requestsTotal}`)
	return { requestsTotal, byApi: snapshots }
}
