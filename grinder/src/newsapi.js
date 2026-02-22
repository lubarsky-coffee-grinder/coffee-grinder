import { log } from './log.js'
import { htmlToText } from './html-to-text.js'
import { fetchArticle } from './fetch-article.js'
import { JSDOM } from 'jsdom'
import { trackApiRequest, trackApiResult } from './cost.js'

const ER_API_BASE = 'https://eventregistry.org/api/v1'
const ER_ANALYTICS_BASE = 'https://analytics.eventregistry.org/api/v1'
const DEFAULT_TIMEOUT_MS = 10e3
const TIMEOUT_MS = readTimeoutMs()
const INFO_BODY_LEN = 30_000
const KEYWORD_FALLBACK_COUNT = 50

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'over', 'under',
	'about', 'after', 'before', 'between', 'while', 'where', 'when', 'what', 'which', 'whose',
	'of', 'in', 'on', 'at', 'to', 'as', 'by', 'via', 'per', 'than',
	'also', 'other', 'more', 'most', 'some', 'than', 'then', 'they', 'them', 'their', 'there',
	'you', 'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its', 'it', 'are', 'was', 'were',
	'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'not', 'but', 'have', 'has',
	'had', 'been', 'being', 'new', 'news', 'latest', 'update', 'live', 'video', 'watch', 'read',
	'world', 'us', 'usa', 'uk', 'eu',
])

function readTimeoutMs() {
	let raw = process.env.NEWS_API_TIMEOUT_MS
	if (raw == null || raw === '') return DEFAULT_TIMEOUT_MS
	let ms = Number(raw)
	if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS
	return ms
}

function get(obj, path) {
	return path.reduce((acc, key) => acc && acc[key], obj)
}

function pickString(obj, paths) {
	for (let path of paths) {
		let v = get(obj, path)
		if (typeof v === 'string' && v.trim()) return v
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

function pickPublishedAt(obj) {
	for (let path of [
		['dateTime'],
		['date'],
		['time'],
		['publishedAt'],
		['pubDate'],
		['dateTimePub'],
		['dateTimePubUtc'],
		['article', 'dateTime'],
		['article', 'date'],
		['article', 'time'],
	]) {
		let iso = normalizePublishedAt(get(obj, path))
		if (iso) return iso
	}
	return ''
}

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

function parseArticleFromHtml(html) {
	let dom
	try {
		dom = new JSDOM(html)
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

	let text = `${title ? title + '\n\n' : ''}${desc ? desc + '\n\n' : ''}${rawText || ''}`
	text = String(text || '').replace(/\n{3,}/g, '\n\n').trim()

	return {
		title: title?.trim(),
		body: text,
		bodyHtml: articleNode ? articleNode.innerHTML : document.body?.innerHTML || html,
	}
}

async function extractArticleDirectly(url) {
	let html = await fetchArticle(url)
	if (!html) return
	let parsed = parseArticleFromHtml(html)
	if (!parsed) return

	if (!parsed.title && !parsed.body) return
	return parsed
}

function firstValue(obj) {
	if (!obj || typeof obj !== 'object') return
	let keys = Object.keys(obj)
	if (!keys.length) return
	return obj[keys[0]]
}

function uniqBy(list, keyFn) {
	let seen = new Set()
	let out = []
	for (let item of list) {
		let key = keyFn(item)
		if (key == null) continue
		if (seen.has(key)) continue
		seen.add(key)
		out.push(item)
	}
	return out
}

function maybeSingularize(s) {
	// Tiny heuristic for URL slugs: "epsteins" -> "epstein".
	if (s.endsWith('s') && s.length > 4 && !s.endsWith('ss')) return s.slice(0, -1)
	return s
}

function slugToKeywords(articleUrl, limit = 20) {
	let u
	try {
		u = new URL(articleUrl)
	} catch {
		return []
	}

	let raw = u.pathname.split('/').filter(Boolean).join('-')
	if (!raw) return []

	raw = raw.replace(/\.[a-z]{2,5}$/i, '')

	let tokens = raw
		.split(/[^A-Za-z0-9]+/g)
		.map(s => s.toLowerCase())
		.filter(s => s.length >= 3)
		.map(maybeSingularize)
		.filter(s => !STOPWORDS.has(s))
		.filter(s => !/^\d+$/.test(s))

	tokens = uniqBy(tokens, s => s)
	return tokens.slice(0, limit)
}

function pickBestEventUri(articles, limit = 10) {
	if (!Array.isArray(articles) || !articles.length) return
	let max = Math.min(limit, articles.length)
	let stats = new Map()
	for (let i = 0; i < max; i++) {
		let uri = articles[i]?.eventUri
		if (!uri) continue
		let s = stats.get(uri)
		if (!s) s = { count: 0, first: i }
		s.count++
		stats.set(uri, s)
	}
	let best
	let bestCount = 0
	let bestFirst = Infinity
	for (let [uri, s] of stats.entries()) {
		if (s.count > bestCount || (s.count === bestCount && s.first < bestFirst)) {
			best = uri
			bestCount = s.count
			bestFirst = s.first
		}
	}
	return best
}

function getApiKey() {
	let apiKey = process.env.NEWS_API_KEY
	if (!apiKey) {
		log('NEWS_API_KEY is missing')
		return
	}
	return apiKey
}

function buildUrl(base, params) {
	let u = new URL(base)
	for (let [k, v] of Object.entries(params || {})) {
		if (v == null) continue
		if (Array.isArray(v)) {
			v.forEach(x => {
				if (x != null) u.searchParams.append(k, String(x))
			})
			continue
		}
		u.searchParams.set(k, String(v))
	}
	return u
}

async function getJson(url, params) {
	let controller = new AbortController()
	let ms = TIMEOUT_MS
	let start = Date.now()
	let t = setTimeout(() => controller.abort(new Error('timeout')), ms)
	let response
	trackApiRequest('newsapi')
	try {
		response = await fetch(buildUrl(url, params), {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		})
		if (!response.ok) {
			trackApiResult('newsapi', 'failed')
			log('newsapi.ai request failed', response.status, response.statusText, `ms=${Date.now() - start}`, 'at', url)
			// Don't keep the connection open if we aren't going to read the body.
			try { await response?.body?.cancel?.() } catch {}
			return
		}
		// AbortController is passed into fetch(), so response body parsing will
		// error out on timeouts without leaving dangling promises behind.
		let json = await response.json()
		if (json?.error) {
			trackApiResult('newsapi', 'failed')
			let extra = []
			if (json.statusCode) extra.push(`statusCode=${json.statusCode}`)
			if (json.usedCustomization) extra.push(`customization=${json.usedCustomization}`)
			extra.push(`ms=${Date.now() - start}`)
			log('newsapi.ai error', json.error, extra.join(' '), 'at', url)
			return
		}
		trackApiResult('newsapi', 'success')
		return json
	} catch (e) {
		if (controller.signal.aborted) {
			trackApiResult('newsapi', 'timeout')
			// Don't log full URL (it contains apiKey).
			log('newsapi.ai request timed out after', (ms / 1e3).toFixed(), 's:', `ms=${Date.now() - start}`, 'at', url)
			return
		}
		trackApiResult('newsapi', 'failed')
		log('newsapi.ai request failed', e, `ms=${Date.now() - start}`, 'at', url)
	} finally {
		clearTimeout(t)
	}
}

export async function extractArticleInfo(url) {
	let apiKey = getApiKey()
	if (!apiKey) return

	let uris = await mapUrlToArticleUris(url)
	if (uris.length) {
		// Prefer the indexed article body (fast, no scraping / paywalls).
		let article = await getArticleWithBody(uris[0])
		let info = article && {
			title: pickString(article, [['title'], ['info', 'title']]),
			body: pickString(article, [['body'], ['bodyText'], ['content'], ['text']]),
			bodyHtml: pickString(article, [['bodyHtml'], ['html'], ['contentHtml']]),
		}
		if (info?.bodyHtml && !info.body) {
			try { info.body = htmlToText(info.bodyHtml) } catch {}
		}
		if (info?.body || info?.bodyHtml) return info
	}

	// Fallback: extract article info by scraping via the analytics API.
	let json = await getJson(`${ER_ANALYTICS_BASE}/extractArticleInfo`, { apiKey, url })
	if (json) {
		let info = {
			title: pickString(json, [
				['title'],
				['article', 'title'],
				['info', 'title'],
			]),
			body: pickString(json, [
				['body'],
				['text'],
				['content'],
				['article', 'body'],
				['article', 'text'],
				['article', 'content'],
				['article', 'bodyText'],
				['article', 'contentText'],
			]),
			bodyHtml: pickString(json, [
				['bodyHtml'],
				['html'],
				['article', 'bodyHtml'],
				['article', 'html'],
				['article', 'contentHtml'],
			]),
		}
		if (info.bodyHtml && !info.body) {
			try { info.body = htmlToText(info.bodyHtml) } catch {}
		}
		if (info.body || info.bodyHtml) return info
	}

	let direct = await extractArticleDirectly(url)
	if (direct?.body || direct?.title) {
		log('newsapi.ai: extracted fallback from direct page for', url)
		if (direct.body) return direct
	}

	// Only log on failure; success is already visible via extracted text length.
	if (!uris.length) log('newsapi.ai: no indexed match for url:', url)
	else log('newsapi.ai: indexed match has no body available for url:', url)
}

async function mapUrlToArticleUris(articleUrl) {
	let apiKey = getApiKey()
	if (!apiKey) return []

	let json = await getJson(`${ER_API_BASE}/articleMapper`, {
		apiKey,
		articleUrl,
		deep: true,
	})
	if (!json) return []

	let mapped = json?.[articleUrl]
	if (!mapped) mapped = firstValue(json)
	if (!mapped) return []

	let uris = Array.isArray(mapped) ? mapped : [mapped]
	return uris.filter(Boolean)
}

async function getArticleInfo(articleUri) {
	let apiKey = getApiKey()
	if (!apiKey) return

	let json = await getJson(`${ER_API_BASE}/article/getArticle`, {
		apiKey,
		resultType: 'info',
		articleUri,
		includeArticleEventUri: true,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
	})
	if (!json) return

	let data = json?.[articleUri]
	if (!data) data = firstValue(json)
	return data?.info
}

async function getArticleWithBody(articleUri) {
	let apiKey = getApiKey()
	if (!apiKey) return

	let json = await getJson(`${ER_API_BASE}/article/getArticle`, {
		apiKey,
		resultType: 'info',
		articleUri,
		infoArticleBodyLen: INFO_BODY_LEN,
		includeArticleBody: true,
		includeArticleEventUri: true,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
	})
	if (!json) return

	let data = json?.[articleUri]
	if (!data) data = firstValue(json)
	return data?.info
}

async function searchArticlesByKeywords(keywords, keywordOper = 'or') {
	let apiKey = getApiKey()
	if (!apiKey) return []
	if (!Array.isArray(keywords) || !keywords.length) return []

	let json = await getJson(`${ER_API_BASE}/article/getArticles`, {
		apiKey,
		resultType: 'articles',
		keyword: keywords,
		keywordOper,
		articlesSortBy: 'rel',
		articlesCount: KEYWORD_FALLBACK_COUNT,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
		includeArticleEventUri: true,
	})
	if (!json) return []

	let results = json?.articles?.results
	if (!Array.isArray(results)) return []

	return results
		.map(a => ({
			url: a?.url,
			title: a?.title,
			source: a?.source?.title,
			sourceUri: a?.source?.uri,
			eventUri: a?.eventUri,
			publishedAt: pickPublishedAt(a),
		}))
		.filter(a => a.url)
}

async function keywordFallbackCandidates(articleUrl, context, keywordsOverride) {
	let keywords = Array.isArray(keywordsOverride) && keywordsOverride.length
		? keywordsOverride
		: slugToKeywords(articleUrl, 20)
	if (!keywords.length) return []
	let mode = Array.isArray(keywordsOverride) && keywordsOverride.length ? 'provided keywords' : 'url keywords'

	log(`newsapi.ai: ${context}; ${mode} (${keywords.length}):`, keywords.join(' '))

	log(`newsapi.ai: ${context}; keyword fallback (and):`, keywords.join(' '))
	return await searchArticlesByKeywords(keywords, 'and')
}

async function keywordFallbackWithEvent(articleUrl, context, keywordsOverride) {
	let base = await keywordFallbackCandidates(articleUrl, context, keywordsOverride)
	if (!base.length) return []

	let eventUri = pickBestEventUri(base, 10)
	if (!eventUri) return base

	let inEvent = base.filter(a => a.eventUri && a.eventUri === eventUri)
	let eventArticles = await getEventArticles(eventUri)
	log('newsapi.ai: keyword fallback eventUri:', eventUri, `inEvent=${inEvent.length}`, `eventArticles=${eventArticles.length}`)

	eventArticles = eventArticles.map(a => ({ ...a, eventUri }))
	let merged = uniqBy(inEvent.concat(eventArticles), a => a.url)
	return merged.length ? merged : base
}

async function getDuplicatedArticles(articleUri) {
	let apiKey = getApiKey()
	if (!apiKey) return []

	let json = await getJson(`${ER_API_BASE}/article/getArticle`, {
		apiKey,
		resultType: 'duplicatedArticles',
		articleUri,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
	})
	if (!json) return []

	let data = json?.[articleUri]
	if (!data) data = firstValue(json)

	let results = data?.duplicatedArticles?.results
	if (!Array.isArray(results)) return []

	return results
		.map(a => ({
			url: a?.url,
			title: a?.title,
			source: a?.source?.title,
			sourceUri: a?.source?.uri,
			publishedAt: pickPublishedAt(a),
		}))
		.filter(a => a.url)
}

async function getEventArticles(eventUri) {
	let apiKey = getApiKey()
	if (!apiKey) return []

	let json = await getJson(`${ER_API_BASE}/event/getEvent`, {
		apiKey,
		resultType: 'articles',
		eventUri,
		articlesIncludeDuplicates: true,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
	})
	if (!json) return []

	let data = json?.[eventUri]
	if (!data) data = firstValue(json)

	let results = data?.articles?.results
	if (!Array.isArray(results)) return []

	return results
		.map(a => ({
			url: a?.url,
			title: a?.title,
			source: a?.source?.title,
			sourceUri: a?.source?.uri,
			publishedAt: pickPublishedAt(a),
		}))
		.filter(a => a.url)
}

export async function findAlternativeArticles(articleUrl, opts) {
	let keywordsOverride = opts?.keywords
	let articleUris = await mapUrlToArticleUris(articleUrl)
	let articles = []
	if (articleUris.length) {
		articles = await getDuplicatedArticles(articleUris[0])

		// If duplicates aren't available, try event-based alternatives (broader).
		let info = await getArticleInfo(articleUris[0])
		let eventUri = info?.eventUri
		if (eventUri) {
			articles = articles.concat(await getEventArticles(eventUri))
		}
	} else {
		articles = await keywordFallbackWithEvent(articleUrl, 'mapper failed', keywordsOverride)
		log('newsapi.ai: keyword fallback candidates:', articles.length)
	}

	if (!articles.length) {
		articles = articles.concat(await keywordFallbackWithEvent(articleUrl, 'no duplicates/event', keywordsOverride))
		log('newsapi.ai: keyword fallback candidates:', articles.length)
	}

	articles = articles.filter(a => a.url !== articleUrl)
	articles = uniqBy(articles, a => a.url)
	return articles.slice(0, 20)
}
