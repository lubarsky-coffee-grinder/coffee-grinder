export function normalizeHostPath(url) {
	if (!url) return ''
	try {
		let parsed = new URL(url)
		let host = parsed.hostname.replace(/^www\./, '').toLowerCase()
		let path = parsed.pathname || '/'
		path = path.replace(/\/+$/, '')
		if (!path) path = '/'
		return `${host}${path}`
	} catch {
		return ''
	}
}

export function isRedirectMismatch(originalUrl, finalUrl) {
	if (!originalUrl || !finalUrl) return false
	let originalKey = normalizeHostPath(originalUrl)
	let finalKey = normalizeHostPath(finalUrl)
	if (!originalKey || !finalKey) return false
	return originalKey !== finalKey
}
