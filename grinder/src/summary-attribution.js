import { resolveAgencyFromUrl } from '../config/agencies.js'

const ATTRIBUTION_TEMPLATES = [
	source => `По данным ${source}.`,
	source => `Об этом сообщает ${source}.`,
	source => `Как пишет ${source}.`,
]

function cleanText(value) {
	return String(value ?? '')
		.replace(/\r/g, '')
		.trim()
}

function cleanSource(value) {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
}

export function fallbackAgencyFromUrl(value) {
	return resolveAgencyFromUrl(value)
}

function stableHash(value) {
	let text = String(value ?? '')
	let hash = 0
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) >>> 0
	}
	return hash
}

function attributionVariants(source) {
	return ATTRIBUTION_TEMPLATES.map(build => build(source))
}

function pickAttributionVariant(row, source) {
	let seed = [
		String(row?.id || '').trim(),
		String(row?.usedUrl || '').trim(),
		String(row?.url || '').trim(),
		source,
	].join('|')
	let index = stableHash(seed) % ATTRIBUTION_TEMPLATES.length
	return ATTRIBUTION_TEMPLATES[index](source)
}

function withTerminalPunctuation(summary) {
	let text = cleanText(summary)
	if (!text) return ''
	if (/[.!?…]$/.test(text)) return text
	return `${text}.`
}

export function resolveSummaryAttributionSource(row) {
	return cleanSource(row?.agency)
}

export function ensureSummaryAttribution(summary, row) {
	let text = cleanText(summary)
	if (!text) return ''

	let source = resolveSummaryAttributionSource(row)
	if (!source) return text

	let variants = attributionVariants(source)
	if (variants.some(variant => text.endsWith(variant))) return text
	let base = withTerminalPunctuation(text)
	return `${base} ${pickAttributionVariant(row, source)}`
}
