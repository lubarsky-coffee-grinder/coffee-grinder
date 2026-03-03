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

function sourceFromUrl(value) {
	if (!value) return ''
	try {
		let host = new URL(String(value).trim()).hostname.toLowerCase()
		return host.replace(/^www\./, '')
	} catch {
		return ''
	}
}

function withTerminalPunctuation(summary) {
	let text = cleanText(summary)
	if (!text) return ''
	if (/[.!?…]$/.test(text)) return text
	return `${text}.`
}

export function resolveSummaryAttributionSource(row) {
	let source = cleanSource(row?.source)
	if (source) return source
	return sourceFromUrl(row?.usedUrl || row?.url)
}

export function ensureSummaryAttribution(summary, row) {
	let text = cleanText(summary)
	if (!text) return ''

	let source = resolveSummaryAttributionSource(row)
	if (!source) return text

	let canonicalAttribution = `По данным ${source}.`
	if (text.endsWith(canonicalAttribution)) return text
	let base = withTerminalPunctuation(text)
	return `${base} ${canonicalAttribution}`
}
