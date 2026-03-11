import { JSDOM, VirtualConsole } from 'jsdom'

import { htmlToText } from './html-to-text.js'
import { log } from './log.js'
import { describeBrightDataUnlockerSettings, unlockUrlWithBrightData } from './brightdata-unlocker.js'

function pickFirstMeta(document, selectors) {
	for (let [nameAttr, contentAttr] of selectors) {
		let metaSelectors = [
			`meta[${nameAttr}="${contentAttr}"]`,
			`meta[${nameAttr}='${contentAttr}']`,
		]
		for (let selector of metaSelectors) {
			let node = document.querySelector(selector)
			if (!node) continue
			let value = node.getAttribute('content') || node.getAttribute('value')
			if (typeof value === 'string' && value.trim()) return value.trim()
		}
	}
}

function normalizePublishedAt(value) {
	if (value == null || value === '') return ''
	if (value instanceof Date) {
		let ms = value.getTime()
		return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
	}
	if (typeof value === 'number') {
		let ms = value
		if (ms > 0 && ms < 1e11) ms *= 1000
		let d = new Date(ms)
		return Number.isFinite(d.getTime()) ? d.toISOString() : ''
	}

	let text = String(value).trim()
	if (!text) return ''

	let d = new Date(text)
	if (Number.isFinite(d.getTime())) return d.toISOString()

	let compact = text.match(/^(\d{4})(\d{2})(\d{2})$/)
	if (compact) {
		let normalized = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`)
		if (Number.isFinite(normalized.getTime())) return normalized.toISOString()
	}
	return ''
}

function pickPublishedAtFromDocument(document) {
	let fromMeta = pickFirstMeta(document, [
		['property', 'article:published_time'],
		['property', 'article:modified_time'],
		['property', 'og:published_time'],
		['property', 'og:updated_time'],
		['name', 'pubdate'],
		['name', 'publish-date'],
		['name', 'published_time'],
		['name', 'date'],
		['itemprop', 'datePublished'],
		['itemprop', 'dateModified'],
	])
	let normalized = normalizePublishedAt(fromMeta)
	if (normalized) return normalized

	let timeNodes = document.querySelectorAll('time[datetime]')
	for (let node of timeNodes || []) {
		let value = node?.getAttribute?.('datetime')
		let iso = normalizePublishedAt(value)
		if (iso) return iso
	}
	return ''
}

function parseArticleFromHtml(html) {
	let dom
	try {
		let virtualConsole = new VirtualConsole()
		dom = new JSDOM(html, { virtualConsole })
	} catch {
		return
	}

	let document = dom.window.document
	let title = ''

	title = pickFirstMeta(document, [
		['property', 'og:title'],
		['name', 'twitter:title'],
		['name', 'title'],
	])

	if (!title) {
		let h1 = document.querySelector('h1')
		if (h1) title = h1.textContent
	}

	if (!title) title = document.title

	let desc = pickFirstMeta(document, [
		['name', 'description'],
		['property', 'og:description'],
		['name', 'twitter:description'],
	])

	let articleNode = document.querySelector('article')
	let rawText = htmlToText(articleNode ? articleNode.innerHTML : document.body?.innerHTML || html)
	let publishedAt = pickPublishedAtFromDocument(document)

	let text = `${title ? title + '\n\n' : ''}${desc ? desc + '\n\n' : ''}${rawText || ''}`
	text = String(text || '').replace(/\n{3,}/g, '\n\n').trim()

	return {
		title: title?.trim(),
		body: text,
		bodyHtml: articleNode ? articleNode.innerHTML : document.body?.innerHTML || html,
		publishedAt,
	}
}

export function describeBrightDataArticleExtractionSettings() {
	return describeBrightDataUnlockerSettings()
}

export async function extractArticleWithBrightData(url, { logger = log } = {}) {
	let normalizedUrl = String(url || '').trim()
	if (!normalizedUrl) return

	let unlocked = await unlockUrlWithBrightData(normalizedUrl)
	if (!unlocked?.ok || !unlocked?.html) {
		logger(
			'Bright Data article extract failed',
			`reason=${unlocked?.reason || 'unknown'}`,
			unlocked?.statusCode ? `status=${unlocked.statusCode}` : '',
			`url=${normalizedUrl}`,
		)
		return
	}

	let parsed = parseArticleFromHtml(unlocked.html)
	if (!parsed?.title && !parsed?.body) {
		logger(
			'Bright Data article extract empty',
			unlocked?.statusCode ? `status=${unlocked.statusCode}` : '',
			`url=${normalizedUrl}`,
		)
		return
	}

	logger(
		'Bright Data article extracted',
		`${String(parsed.body || '').length} chars`,
		unlocked?.statusCode ? `status=${unlocked.statusCode}` : '',
		`url=${normalizedUrl}`,
	)
	return {
		...parsed,
		statusCode: unlocked.statusCode || 0,
	}
}
