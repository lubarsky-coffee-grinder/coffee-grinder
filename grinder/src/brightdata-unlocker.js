import { readEnv } from './env.js'

const BRIGHT_DATA_API_KEY = readEnv('BRIGHT_DATA_API_KEY')
const BRIGHT_DATA_WEB_UNLOCKER_FORMAT = 'browserHtml'
const BRIGHT_DATA_HTML_DATA_FORMAT = 'html'
const BRIGHT_DATA_SCREENSHOT_DATA_FORMAT = 'screenshot'
const BRIGHT_DATA_COUNTRY = 'us'
const BRIGHT_DATA_TIMEOUT_MS = 25000
const BRIGHT_DATA_SCREENSHOT_TIMEOUT_MS = 30000
const BRIGHT_DATA_SCREENSHOT_TIMEOUT_RETRY_MS = 45000

let loadState = null
let brightDataClient = null

function withTimeout(promise, ms, label) {
	let timer
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
		}),
	]).finally(() => clearTimeout(timer))
}

function normalizeText(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
}

function hasConfiguredApiKey(value) {
	let key = String(value || '').trim()
	if (!key) return false
	if (/^your_api_key_here$/i.test(key)) return false
	if (/^change_me$/i.test(key)) return false
	return key.length >= 16
}

function looksLikeHtml(value) {
	let text = String(value || '').trim()
	if (!text) return false
	return /<(?:!doctype\s+html|html|head|body|main|article|section|div|p|h1)\b/i.test(text)
}

function looksLikeDataImage(value) {
	return /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(value || '').trim())
}

function normalizeBase64(value) {
	return String(value || '').replace(/\s+/g, '').trim()
}

function looksLikeBase64Image(value) {
	let v = normalizeBase64(value)
	if (!v || v.length < 800) return false
	return /^[A-Za-z0-9+/=]+$/.test(v)
}

function looksLikeHttpUrl(value) {
	try {
		let url = new URL(String(value || '').trim())
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

function looksLikeImageUrl(value) {
	let url = String(value || '').trim()
	if (!looksLikeHttpUrl(url)) return false
	return /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(url) || /(?:image|img|screenshot|render|snapshot)/i.test(url)
}

function parseJsonText(value) {
	try {
		return JSON.parse(String(value || '').trim())
	} catch {
		return null
	}
}

function maybeDecodeBase64Html(value) {
	let raw = String(value || '').trim()
	if (!raw || raw.length < 24) return ''
	if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) return ''
	try {
		let decoded = Buffer.from(raw, 'base64').toString('utf8')
		if (looksLikeHtml(decoded)) return decoded
	} catch {}
	return ''
}

function extractHtml(value, depth = 0) {
	if (depth > 6 || value == null) return ''
	if (typeof value === 'string') {
		if (looksLikeHtml(value)) return value
		return maybeDecodeBase64Html(value)
	}
	if (Array.isArray(value)) {
		for (let item of value) {
			let html = extractHtml(item, depth + 1)
			if (html) return html
		}
		return ''
	}
	if (typeof value === 'object') {
		const preferred = [
			'browserHtml',
			'html',
			'content',
			'body',
			'pageHtml',
			'renderedHtml',
			'result',
			'data',
			'response',
		]
		for (let key of preferred) {
			if (!(key in value)) continue
			let html = extractHtml(value[key], depth + 1)
			if (html) return html
		}
		for (let key of Object.keys(value)) {
			let html = extractHtml(value[key], depth + 1)
			if (html) return html
		}
	}
	return ''
}

function extractImagePayload(value, depth = 0) {
	if (depth > 8 || value == null) return null
	if (typeof value === 'string') {
		let raw = String(value || '').trim()
		if (!raw) return null
		if (looksLikeDataImage(raw)) {
			let m = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
			if (!m) return null
			let mime = String(m[1] || '').toLowerCase() || 'image/jpeg'
			let base64 = normalizeBase64(m[2] || '')
			if (!looksLikeBase64Image(base64)) return null
			return { mime, base64 }
		}
		if (looksLikeBase64Image(raw)) {
			return { mime: 'image/jpeg', base64: normalizeBase64(raw) }
		}
		if (raw.startsWith('{') || raw.startsWith('[')) {
			let parsed = parseJsonText(raw)
			if (!parsed) return null
			return extractImagePayload(parsed, depth + 1)
		}
		return null
	}
	if (Array.isArray(value)) {
		for (let item of value) {
			let found = extractImagePayload(item, depth + 1)
			if (found) return found
		}
		return null
	}
	if (typeof value === 'object') {
		const preferred = [
			'screenshot',
			'image',
			'imageBase64',
			'image_base64',
			'body',
			'data',
			'result',
			'response',
			'content',
		]
		for (let key of preferred) {
			if (!(key in value)) continue
			let found = extractImagePayload(value[key], depth + 1)
			if (found) return found
		}
		for (let key of Object.keys(value)) {
			let found = extractImagePayload(value[key], depth + 1)
			if (found) return found
		}
	}
	return null
}

function extractImageUrl(value, depth = 0) {
	if (depth > 8 || value == null) return ''
	if (typeof value === 'string') {
		let raw = String(value || '').trim()
		if (!raw) return ''
		if (looksLikeImageUrl(raw)) return raw
		if (raw.startsWith('{') || raw.startsWith('[')) {
			let parsed = parseJsonText(raw)
			if (!parsed) return ''
			return extractImageUrl(parsed, depth + 1)
		}
		return ''
	}
	if (Array.isArray(value)) {
		for (let item of value) {
			let found = extractImageUrl(item, depth + 1)
			if (found) return found
		}
		return ''
	}
	if (typeof value === 'object') {
		const preferred = [
			'screenshotUrl',
			'screenshot_url',
			'imageUrl',
			'image_url',
			'downloadUrl',
			'download_url',
			'resourceUrl',
			'resource_url',
			'url',
			'screenshot',
			'image',
			'body',
			'data',
			'result',
			'response',
			'content',
		]
		for (let key of preferred) {
			if (!(key in value)) continue
			let found = extractImageUrl(value[key], depth + 1)
			if (found) return found
		}
		for (let key of Object.keys(value)) {
			let found = extractImageUrl(value[key], depth + 1)
			if (found) return found
		}
	}
	return ''
}

function inferMimeFromUrl(url) {
	let text = String(url || '').toLowerCase()
	if (text.includes('.png')) return 'image/png'
	if (text.includes('.webp')) return 'image/webp'
	if (text.includes('.gif')) return 'image/gif'
	if (text.includes('.bmp')) return 'image/bmp'
	if (text.includes('.svg')) return 'image/svg+xml'
	return 'image/jpeg'
}

async function fetchImageAsBase64(imageUrl, timeoutMs) {
	try {
		const response = await withTimeout(fetch(imageUrl, { method: 'GET', redirect: 'follow' }), timeoutMs, 'brightdata_image_fetch')
		if (!response?.ok) return null
		const contentType = String(response.headers.get('content-type') || '').toLowerCase()
		if (contentType && !contentType.startsWith('image/')) return null
		const bytes = await withTimeout(response.arrayBuffer(), timeoutMs, 'brightdata_image_bytes')
		const base64 = Buffer.from(bytes).toString('base64')
		if (!looksLikeBase64Image(base64)) return null
		const mime = contentType.startsWith('image/')
			? contentType.split(';')[0].trim()
			: inferMimeFromUrl(imageUrl)
		return { mime, base64 }
	} catch {
		return null
	}
}

function pickStatusCode(value) {
	if (!value || typeof value !== 'object') return 0
	let candidates = [
		value.status,
		value.statusCode,
		value.status_code,
		value.http_status,
		value.code,
		value?.response?.status,
		value?.response?.statusCode,
		value?.response?.status_code,
	]
	for (let v of candidates) {
		let n = Number(v)
		if (Number.isFinite(n) && n > 0) return n
	}
	return 0
}

function classifyError(error) {
	let message = String(error?.message || error || '').trim()
	let statusCode = pickStatusCode(error)
	let responseBody = ''
	try {
		responseBody = JSON.stringify(error?.response?.data || error?.body || error?.data || {})
	} catch {}
	let scan = normalizeText([message, responseBody, error?.name || '', error?.code || ''].join(' '))

	let isLimit =
		statusCode === 429
		|| statusCode === 402
		|| scan.includes('quota')
		|| scan.includes('rate limit')
		|| scan.includes('monthly limit')
		|| scan.includes('insufficient credit')
		|| scan.includes('credits')
		|| scan.includes('payment required')
		|| scan.includes('too many requests')

	if (isLimit) {
		return {
			reason: 'api_limit_reached',
			limitReached: true,
			statusCode,
			message: message || 'Bright Data API limit reached',
		}
	}
	if (scan.includes('timeout') || scan.includes('timed out')) {
		return {
			reason: 'api_timeout',
			limitReached: false,
			statusCode,
			message: message || 'Bright Data API timeout',
		}
	}
	return {
		reason: 'api_error',
		limitReached: false,
		statusCode,
		message: message || 'Bright Data API error',
	}
}

async function getClientState() {
	if (!hasConfiguredApiKey(BRIGHT_DATA_API_KEY)) {
		return { ok: false, reason: 'disabled_no_api_key' }
	}
	if (!loadState) {
		try {
			const mod = await import('@brightdata/sdk')
			loadState = { ok: true, mod }
		} catch (error) {
			loadState = { ok: false, reason: 'sdk_not_installed', error }
		}
	}
	if (!loadState.ok) return { ok: false, reason: loadState.reason, error: loadState.error }
	if (brightDataClient) {
		return { ok: true, client: brightDataClient.client, mode: brightDataClient.mode }
	}

	const candidates = [
		loadState.mod?.bdclient,
		loadState.mod?.default?.bdclient,
		loadState.mod?.BrightData,
		loadState.mod?.default?.BrightData,
		loadState.mod?.default,
	]
		.filter(v => typeof v === 'function')

	if (!candidates.length) {
		return { ok: false, reason: 'sdk_invalid_export' }
	}

	let lastError = null
	for (let Ctor of candidates) {
		let instances = []
		try {
			instances.push(new Ctor({ apiKey: BRIGHT_DATA_API_KEY }))
		} catch (e) {
			lastError = e
		}
		try {
			instances.push(new Ctor({ api_token: BRIGHT_DATA_API_KEY }))
		} catch (e) {
			lastError = e
		}
		try {
			instances.push(Ctor({ apiKey: BRIGHT_DATA_API_KEY }))
		} catch (e) {
			lastError = e
		}
		try {
			instances.push(Ctor({ api_token: BRIGHT_DATA_API_KEY }))
		} catch (e) {
			lastError = e
		}

		for (let inst of instances) {
			if (!inst || typeof inst !== 'object') continue
			if (typeof inst.scrape === 'function') {
				brightDataClient = { mode: 'scrape', client: inst }
				return { ok: true, mode: brightDataClient.mode, client: brightDataClient.client }
			}
			if (inst.web && typeof inst.web.unlock === 'function') {
				brightDataClient = { mode: 'web_unlock', client: inst }
				return { ok: true, mode: brightDataClient.mode, client: brightDataClient.client }
			}
		}
	}

	return {
		ok: false,
		reason: 'sdk_invalid_export',
		error: lastError,
	}
}

export function describeBrightDataUnlockerSettings() {
	if (!hasConfiguredApiKey(BRIGHT_DATA_API_KEY)) {
		return 'brightdata_web_unlocker=off(reason=no_api_key)'
	}
	return `brightdata_web_unlocker=on(strategy=${BRIGHT_DATA_HTML_DATA_FORMAT}_then_${BRIGHT_DATA_SCREENSHOT_DATA_FORMAT}, country=${BRIGHT_DATA_COUNTRY}, html_timeout_ms=${BRIGHT_DATA_TIMEOUT_MS}, screenshot_timeout_ms=${BRIGHT_DATA_SCREENSHOT_TIMEOUT_MS})`
}

async function requestHtmlWithBrightData(state, { url, format, timeoutMs }) {
	if (state.mode === 'web_unlock') {
		return await withTimeout(
			state.client.web.unlock({
				url,
				format: BRIGHT_DATA_WEB_UNLOCKER_FORMAT,
				method: 'GET',
			}),
			timeoutMs,
			'brightdata_web_unlock_html',
		)
	}
	return await withTimeout(
		state.client.scrape(url, {
			format: format || 'raw',
			method: 'GET',
			country: BRIGHT_DATA_COUNTRY,
			timeout: timeoutMs,
			dataFormat: BRIGHT_DATA_HTML_DATA_FORMAT,
		}),
		timeoutMs,
		'brightdata_scrape_html',
	)
}

async function requestScreenshotWithBrightData(state, { url, format, timeoutMs }) {
	if (state.mode === 'web_unlock') {
		return await withTimeout(
			state.client.web.unlock({
				url,
				format: BRIGHT_DATA_SCREENSHOT_DATA_FORMAT,
				method: 'GET',
			}),
			timeoutMs,
			'brightdata_web_unlock_screenshot',
		)
	}
	return await withTimeout(
		state.client.scrape(url, {
			format: format || 'raw',
			method: 'GET',
			country: BRIGHT_DATA_COUNTRY,
			timeout: timeoutMs,
			dataFormat: BRIGHT_DATA_SCREENSHOT_DATA_FORMAT,
		}),
		timeoutMs,
		'brightdata_scrape_screenshot',
	)
}

export async function unlockUrlWithBrightData(url) {
	let state = await getClientState()
	if (!state.ok) {
		return {
			ok: false,
			skipped: true,
			reason: state.reason,
			error: state.error ? String(state.error?.message || state.error) : '',
			limitReached: false,
			statusCode: 0,
		}
	}

	let request = {
		url: String(url || '').trim(),
	}
	if (!request.url) {
		return {
			ok: false,
			skipped: true,
			reason: 'empty_url',
			limitReached: false,
			statusCode: 0,
		}
	}

	try {
		let response = await requestHtmlWithBrightData(state, {
			url: request.url,
			format: 'raw',
			timeoutMs: BRIGHT_DATA_TIMEOUT_MS,
		})
		let html = extractHtml(response)
		let statusResponse = response
		if (!html && state.mode === 'scrape') {
			let jsonResponse = await requestHtmlWithBrightData(state, {
				url: request.url,
				format: 'json',
				timeoutMs: BRIGHT_DATA_TIMEOUT_MS,
			})
			html = extractHtml(jsonResponse)
			if (html) statusResponse = jsonResponse
		}
		if (!html) {
			return {
				ok: false,
				skipped: true,
				reason: 'empty_html',
				limitReached: false,
				statusCode: pickStatusCode(statusResponse),
			}
		}
		return {
			ok: true,
			html,
			statusCode: pickStatusCode(statusResponse),
		}
	} catch (error) {
		let c = classifyError(error)
		return {
			ok: false,
			skipped: true,
			reason: c.reason,
			limitReached: c.limitReached,
			statusCode: c.statusCode,
			error: c.message,
		}
	}
}

export async function captureScreenshotWithBrightData(url) {
	let state = await getClientState()
	if (!state.ok) {
		return {
			ok: false,
			skipped: true,
			reason: state.reason,
			error: state.error ? String(state.error?.message || state.error) : '',
			limitReached: false,
			statusCode: 0,
		}
	}
	let normalizedUrl = String(url || '').trim()
	if (!normalizedUrl) {
		return {
			ok: false,
			skipped: true,
			reason: 'empty_url',
			limitReached: false,
			statusCode: 0,
		}
	}
	let attempts = [BRIGHT_DATA_SCREENSHOT_TIMEOUT_MS, BRIGHT_DATA_SCREENSHOT_TIMEOUT_RETRY_MS]
	let lastFailure = null
	for (let i = 0; i < attempts.length; i++) {
		let timeoutMs = attempts[i]
		try {
			let response = await requestScreenshotWithBrightData(state, {
				url: normalizedUrl,
				format: 'raw',
				timeoutMs,
			})
			let image = extractImagePayload(response)
			let imageUrl = ''
			if (!image) {
				imageUrl = extractImageUrl(response)
				if (imageUrl) {
					image = await fetchImageAsBase64(imageUrl, Math.min(15000, timeoutMs))
				}
			}
			let statusResponse = response
			if (!image && state.mode === 'scrape') {
				let jsonResponse = await requestScreenshotWithBrightData(state, {
					url: normalizedUrl,
					format: 'json',
					timeoutMs,
				})
				image = extractImagePayload(jsonResponse)
				if (!image) {
					imageUrl = extractImageUrl(jsonResponse)
					if (imageUrl) {
						image = await fetchImageAsBase64(imageUrl, Math.min(15000, timeoutMs))
					}
				}
				if (image) statusResponse = jsonResponse
			}
			if (image) {
				return {
					ok: true,
					mime: image.mime || 'image/jpeg',
					base64: image.base64,
					statusCode: pickStatusCode(statusResponse),
				}
			}
			lastFailure = {
				ok: false,
				skipped: true,
				reason: 'empty_image',
				limitReached: false,
				statusCode: pickStatusCode(statusResponse),
				error: imageUrl ? `image_url_unreadable:${imageUrl.slice(0, 180)}` : '',
			}
		} catch (error) {
			let c = classifyError(error)
			lastFailure = {
				ok: false,
				skipped: true,
				reason: c.reason,
				limitReached: c.limitReached,
				statusCode: c.statusCode,
				error: c.message,
			}
			if (c.reason === 'api_timeout' && i < attempts.length - 1) continue
			return lastFailure
		}
	}
	return lastFailure || {
		ok: false,
		skipped: true,
		reason: 'empty_image',
		limitReached: false,
		statusCode: 0,
		error: '',
	}
}
