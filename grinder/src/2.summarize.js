import fs from 'fs'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { news, save } from './store.js'
import { topics, topicsMap, normalizeTopic } from '../config/topics.js'
// import { restricted } from '../config/agencies.js'
import { decodeGoogleNewsUrl } from './google-news.js'
import { extractArticleAgency, extractArticleDate, extractArticleInfo, findAlternativeArticles } from './newsapi.js'
import { ai } from './ai.js'
import {
	collectAlternativeUrlsByStory,
	collectFacts,
	collectTalkingPoints,
	collectVideos,
	collectTitleByUrl,
	describeAlternativeUrlLookupSettings,
	describeFactsSettings,
	describeTalkingPointsSettings,
	describeVideosSettings,
	describeTitleLookupSettings,
} from './enrich.js'
import { extractFallbackKeywords, describeFallbackKeywordsSettings } from './fallback-keywords.js'
import { logRunApiStats, logRunTotalCost } from './cost.js'
import { ensureSummaryAttribution, fallbackAgencyFromUrl, resolveSummaryAttributionSource } from './summary-attribution.js'
import { describeBrightDataArticleExtractionSettings, extractArticleWithBrightData } from './brightdata-article.js'

const MIN_TEXT_LENGTH = 400
const MAX_TEXT_LENGTH = 30000
const FALLBACK_MAX_KEYWORDS = 20
const TALKING_POINTS_MAX_ITEMS = 5
const STORY_DATE_RECENCY_DAYS = 5

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

function uniq(list) {
	let seen = new Set()
	let out = []
	for (let v of list) {
		if (!v) continue
		if (seen.has(v)) continue
		seen.add(v)
		out.push(v)
	}
	return out
}

function maybeSingularize(s) {
	if (s.endsWith('s') && s.length > 4 && !s.endsWith('ss')) return s.slice(0, -1)
	return s
}

function urlKeywords(articleUrl, limit = FALLBACK_MAX_KEYWORDS) {
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

	return uniq(tokens).slice(0, limit)
}

function countKeywordHits(haystack, keywords) {
	let h = String(haystack || '').toLowerCase()
	let hits = 0
	for (let k of keywords || []) {
		if (!k) continue
		if (h.includes(k.toLowerCase())) hits++
	}
	return hits
}

function textKeywords(value, limit = 16) {
	let tokens = String(value || '')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/gu)
		.map(s => s.trim())
		.filter(s => Array.from(s).length >= 4)
		.filter(s => !STOPWORDS.has(s))
		.filter(s => !/^\d+$/.test(s))
	return uniq(tokens).slice(0, limit)
}

const GENERIC_STORY_KEYWORDS = new Set([
	'live', 'update', 'updates', 'latest', 'breaking', 'story', 'news',
	'middle', 'east', 'world', 'today',
	'новости', 'обновления', 'срочно', 'сегодня',
])

function storyStrictKeywords(e, sourceUrl) {
	let fromTitle = uniq([
		...textKeywords(e?.titleEn, 12),
		...textKeywords(e?.titleRu, 12),
	]).filter(k => !GENERIC_STORY_KEYWORDS.has(k))

	let fromUrl = urlKeywords(sourceUrl, 12)
	return uniq([
		...fromTitle,
		...fromUrl.filter(k => !GENERIC_STORY_KEYWORDS.has(k)),
	]).slice(0, 12)
}

function normalizeHttpUrl(value) {
	if (!value) return ''
	try {
		let u = new URL(String(value).trim())
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
		return u.toString()
	} catch {
		return ''
	}
}

function parseUrlLines(value) {
	return String(value ?? '')
		.replace(/\r/g, '\n')
		.split(/\n|,/g)
		.map(v => normalizeHttpUrl(v))
		.filter(Boolean)
}

function mergeUrlLines(existingValue, nextUrls) {
	let merged = uniq([
		...parseUrlLines(existingValue),
		...(nextUrls || []).map(v => normalizeHttpUrl(v)).filter(Boolean),
	])
	return merged.join('\n')
}

function ensureColumns(table, cols) {
	table.headers ||= []
	for (let c of cols) {
		if (!table.headers.includes(c)) table.headers.push(c)
	}
}

function migrateArgumentsColumn(table) {
	table.headers ||= []
	let normalizedHeaders = []
	let seen = new Set()
	for (let raw of table.headers) {
		let key = String(raw ?? '').trim()
		if (!key) continue
		// Deprecated: talkingPointsRu is a legacy alias; target column is arguments.
		if (key === 'talkingPointsRu') key = 'arguments'
		if (seen.has(key)) continue
		seen.add(key)
		normalizedHeaders.push(key)
	}
	table.headers = normalizedHeaders

	for (let row of table || []) {
		// Deprecated: talkingPointsRu is preserved here only for one-way migration into arguments.
		let oldValue = String(row?.talkingPointsRu ?? '').trim()
		let newValue = String(row?.arguments ?? '').trim()
		if (oldValue && !newValue) row.arguments = oldValue
		// Deprecated: drop the legacy alias once all rows are clean.
		if (Object.prototype.hasOwnProperty.call(row, 'talkingPointsRu')) delete row.talkingPointsRu
	}
}

function normalizeText(text) {
	return String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeDateIso(value) {
	let raw = String(value ?? '').trim()
	if (!raw) return ''

	let parsed = new Date(raw)
	if (Number.isFinite(parsed.getTime())) return parsed.toISOString()

	let compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
	if (!compact) return ''
	let normalized = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`)
	return Number.isFinite(normalized.getTime()) ? normalized.toISOString() : ''
}

function normalizeRecentStoryDate(value) {
	let iso = normalizeDateIso(value)
	if (!iso) return ''
	let ms = new Date(iso).getTime()
	if (!Number.isFinite(ms)) return ''
	return Math.abs(ms - Date.now()) <= STORY_DATE_RECENCY_DAYS * 24 * 60 * 60e3 ? iso : ''
}

const URL_MONTH_NUMBERS = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
}

function monthNumberFromToken(token) {
	let key = String(token ?? '').trim().toLowerCase()
	return URL_MONTH_NUMBERS[key] || 0
}

function buildValidatedIsoDate(year, month, day = 1) {
	let y = Number(year)
	let m = Number(month)
	let d = Number(day)
	if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ''
	if (m < 1 || m > 12 || d < 1 || d > 31) return ''

	let resolved = new Date(Date.UTC(y, m - 1, d))
	if (!Number.isFinite(resolved.getTime())) return ''
	if (resolved.getUTCFullYear() !== y || resolved.getUTCMonth() !== m - 1 || resolved.getUTCDate() !== d) return ''
	return resolved.toISOString()
}

function hasResolvableAgencyInput(e) {
	return !!(
		normalizeHttpUrl(e?.usedUrl)
		|| normalizeHttpUrl(e?.url)
	)
}

function inferDateFromUrl(url) {
	let normalizedUrl = normalizeHttpUrl(url)
	if (!normalizedUrl) return ''

	let path = ''
	try {
		path = new URL(normalizedUrl).pathname || ''
	} catch {
		return ''
	}

	let match = path.match(/(20\d{2})[\/._-](\d{1,2})[\/._-](\d{1,2})/)
	if (match) return buildValidatedIsoDate(match[1], match[2], match[3])

	match = path.match(/\b(20\d{2})(\d{2})(\d{2})\b/)
	if (match) return buildValidatedIsoDate(match[1], match[2], match[3])

	let namedMatch = path.match(/(?:^|[\/._-])(20\d{2})[\/._-]([a-z]{3,9})[\/._-](\d{1,2})(?:[\/._-]|$)/i)
	if (namedMatch) {
		let month = monthNumberFromToken(namedMatch[2])
		if (month) return buildValidatedIsoDate(namedMatch[1], month, namedMatch[3])
	}

	return ''
}

function resolveStoryDate({ sourceUrl, extractedPublishedAt }) {
	return normalizeRecentStoryDate(extractedPublishedAt)
		|| normalizeRecentStoryDate(inferDateFromUrl(sourceUrl))
		|| ''
}

function readCachedArticle(id, expectedUrl = '') {
	let key = String(id ?? '').trim()
	if (!key) return null
	let file = `articles/${key}.txt`
	if (!fs.existsSync(file)) return null
	let raw = ''
	try {
		raw = String(fs.readFileSync(file, 'utf8') || '')
	} catch {
		return null
	}

	let [header, ...rest] = raw.replace(/\r/g, '').split('\n\n')
	if (!header || !rest.length) return null

	let meta = {}
	for (let line of header.split('\n')) {
		let match = line.match(/^([A-Za-z]+):\s*(.*)$/)
		if (!match) continue
		meta[match[1]] = String(match[2] || '').trim()
	}

	let cacheUrl = normalizeHttpUrl(meta.URL || '')
	let text = normalizeText(rest.join('\n\n'))
	if (!cacheUrl || !text) return null

	let expected = normalizeHttpUrl(expectedUrl || '')
	if (expected && cacheUrl !== expected) return null

	let html = ''
	let htmlFile = `articles/${key}.html`
	if (fs.existsSync(htmlFile)) {
		try {
			let rawHtml = String(fs.readFileSync(htmlFile, 'utf8') || '')
			let match = rawHtml.match(/^<!--\s*\n[\s\S]*?\n-->\n?([\s\S]*)$/)
			html = String(match?.[1] || '').trim()
		} catch {}
	}

	return {
		url: cacheUrl,
		title: String(meta.Title || '').trim(),
		agency: cleanAgencyName(meta.Agency || ''),
		publishedAt: normalizeDateIso(meta.PublishedAt || ''),
		eventUri: String(meta.EventUri || '').trim(),
		html,
		text: text.slice(0, MAX_TEXT_LENGTH),
	}
}

function hasMeaningfulText(value) {
	let text = String(value ?? '')
		.replace(/\u200B/g, '')
		.trim()
	if (!text) return false
	if (/^\{\{\s*[^{}]+\s*\}\}$/.test(text)) return false
	return true
}

function hasVideoLinks(value) {
	return normalizeVideoUrls(value).length > 0
}

function isHttpUrl(value) {
	if (!value) return false
	try {
		let url = new URL(String(value).trim())
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

function isYoutubeUrl(value) {
	if (!isHttpUrl(value)) return false
	try {
		let host = new URL(String(value).trim()).hostname.toLowerCase().replace(/^www\./, '')
		return host === 'youtube.com'
			|| host.endsWith('.youtube.com')
			|| host === 'youtu.be'
			|| host === 'youtube-nocookie.com'
			|| host.endsWith('.youtube-nocookie.com')
	} catch {
		return false
	}
}

function isDirectYoutubeVideoUrl(value) {
	if (!isYoutubeUrl(value)) return false
	try {
		let u = new URL(String(value).trim())
		let host = u.hostname.toLowerCase().replace(/^www\./, '')
		if (host === 'youtu.be') {
			let id = String(u.pathname || '').replace(/^\/+/, '').split('/')[0]
			return !!id
		}
		if (!(host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com'))) return false
		if (u.pathname === '/watch') return !!u.searchParams.get('v')
		if (/^\/embed\/[^/?#]+/.test(u.pathname)) return true
		if (/^\/shorts\/[^/?#]+/.test(u.pathname)) return true
		if (/^\/live\/[^/?#]+/.test(u.pathname)) return true
		return false
	} catch {
		return false
	}
}

function normalizeVideoUrls(value) {
	let text = String(value ?? '').trim()
	if (!text) return ''
	let matches = text.match(/https?:\/\/[^\s]+/g) || []
	let urls = uniq(
		matches
			.map(u => String(u).replace(/[),.;!?]+$/g, '').trim())
			.filter(isDirectYoutubeVideoUrl)
	)
	return urls.join('\n')
}

function isFactsRefusalLine(line) {
	let normalized = String(line || '')
		.toLowerCase()
		.replace(/[«»"'`“”]/g, '')
		.replace(/\.+$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	return normalized === 'недостаточно надёжных дополняющих фактов'
		|| normalized === 'недостаточно надежных дополняющих фактов'
}

function hasFactsRefusalMarker(value) {
	let raw = String(value ?? '')
		.replace(/\r/g, '\n')
		.trim()
	if (!raw) return false

	let rows = raw
		.split('\n')
		.map(s => s.trim())
		.filter(Boolean)
	if (rows.some(isFactsRefusalLine)) return true

	let normalized = raw
		.toLowerCase()
		.replace(/[«»"'`“”]/g, '')
		.replace(/\s+/g, ' ')
	return normalized.includes('недостаточно надёжных дополняющих фактов')
		|| normalized.includes('недостаточно надежных дополняющих фактов')
}

function hasMeaningfulFacts(value) {
	let text = String(value ?? '')
		.replace(/\u200B/g, '')
		.trim()
	if (!text) return false

	for (let row of text.split('\n')) {
		let line = String(row || '')
			.replace(/^[•*\-\u2022]+\s*/, '')
			.trim()
		if (!line) continue
		if (isFactsRefusalLine(line)) continue
		return true
	}
	return false
}

function stripFactSourceNoise(line) {
	let text = String(line || '').trim()
	if (!text) return ''

	text = text
		.replace(/\[[^\]]+\]\((?:https?:\/\/)?[^)\s]+[^)]*\)/gi, '')
		.replace(/\(\s*\[[^\]]+\]\(\s*$/g, '')
		.replace(/\[[^\]]+\]\(\s*$/g, '')
		.replace(/\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi, '')
		.replace(/\(\s*[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s)]*)?\s*\)/gi, '')
		.replace(/\s+\(?\[[a-z0-9.-]+\.[a-z]{2,}[^\]]*\]\(?\s*$/gi, '')
		.replace(/\s+\(?@[\w.:-]+\)?\s*$/gi, '')
		.replace(/\s+\(?(?:https?:\/\/|www\.)\S+\)?\s*$/gi, '')
		.replace(/\s+\(?[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?\)?\s*$/gi, '')
		.replace(/\s+/g, ' ')
		.trim()

	return /[\p{L}\p{N}]/u.test(text) ? text : ''
}

function normalizeFactsValue(value) {
	let raw = String(value ?? '')
		.replace(/\r/g, '')
		.trim()
	if (!raw) return ''

	let rows = raw
		.split('\n')
		.map(s => s.trim())
		.filter(Boolean)

	let out = []
	for (let row of rows) {
		let line = row.replace(/^[•*\-\u2022]+\s*/, '').trim()
		if (!line) continue

		if (line.includes('||')) {
			line = String(line.split('||')[0] ?? '').trim()
		}
		line = line
			.replace(/\s*\|\|\s*.*$/g, '')
			.replace(/https?:\/\/\S+/gi, '')
		line = stripFactSourceNoise(line)
		line = line
			.replace(/\s+/g, ' ')
			.trim()
		if (!line) continue
		if (isFactsRefusalLine(line)) continue
		out.push(line)
	}

	return out.join('\n').trim()
}

function normalizeTalkingPointsValue(value) {
	let raw = String(value ?? '')
		.replace(/\r/g, '')
		.trim()
	if (!raw) return ''

	raw = raw
		.replace(/^```(?:\w+)?\s*/i, '')
		.replace(/\s*```$/, '')
		.trim()

	let parts = raw
		.split(/\n\s*\n/g)
		.map(s => s.trim())
		.filter(Boolean)

	if (parts.length < 2) {
		parts = raw
			.split('\n')
			.map(s => s.trim())
			.filter(Boolean)
	}

	let out = []
	for (let part of parts) {
		let line = part
			.replace(/^[•*\-\u2022]+\s*/, '')
			.replace(/^\d+[.)]\s*/, '')
			.replace(/\s+/g, ' ')
			.trim()
		if (!line) continue
		out.push(line)
	}

	return out.slice(0, TALKING_POINTS_MAX_ITEMS).join('\n\n').trim()
}

function buildTalkingPointsInput({
	articleText,
	titleEn,
	titleRu,
	summary,
	factsRu,
	agency,
	url,
}) {
	let fullText = String(articleText || '').trim()
	if (fullText.length > MIN_TEXT_LENGTH) return fullText

	let title = String(titleRu || titleEn || '').trim()
	let summaryText = String(summary || '').trim()
	let sourceText = String(agency || '').trim()
	let urlText = String(url || '').trim()
	let factsText = String(factsRu || '')
		.replace(/\r/g, '\n')
		.split('\n')
		.map(s => s.trim())
		.filter(Boolean)
		.slice(0, 8)
		.join('\n')
	let shortExtract = fullText ? fullText.slice(0, 3000) : ''

	let chunks = []
	if (title) chunks.push(`Title: ${title}`)
	if (sourceText) chunks.push(`Source: ${sourceText}`)
	if (summaryText) chunks.push(`Summary:\n${summaryText}`)
	if (factsText) chunks.push(`Known facts:\n${factsText}`)
	if (shortExtract) chunks.push(`Article extract:\n${shortExtract}`)
	if (urlText) chunks.push(`URL: ${urlText}`)

	return chunks.join('\n\n').trim()
}

function cleanAgencyName(value) {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim()
}

function talkingPointsStats(value) {
	let points = String(value ?? '')
		.split(/\n\s*\n/g)
		.map(s => s.trim())
		.filter(Boolean)
	let wordCounts = points.map(point =>
		point
			.replace(/[^\p{L}\p{N}\s-]/gu, ' ')
			.split(/\s+/)
			.filter(Boolean).length
	)
	return { count: points.length, wordCounts }
}

function escapeHtml(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

function wrapHtml({ url, html, text }) {
	if (html) {
		return `<!--\n${url}\n-->\n${html}`
	}
	if (text) {
		return `<!--\n${url}\n-->\n<pre>${escapeHtml(text)}</pre>`
	}
	return `<!--\n${url}\n-->`
}

function writeArticleCache(id, extracted, title = '') {
	let key = String(id ?? '').trim()
	if (!key) return
	fs.writeFileSync(`articles/${key}.html`, wrapHtml(extracted))
	let cacheUrl = normalizeHttpUrl(extracted?.url || '')
	let cacheAgency = cleanAgencyName(extracted?.source || '')
	let cachePublishedAt = normalizeDateIso(extracted?.publishedAt || '')
	let cacheEventUri = String(extracted?.eventUri || '').trim()
	fs.writeFileSync(
		`articles/${key}.txt`,
		[
			`URL: ${cacheUrl}`,
			`Title: ${title || ''}`,
			`Agency: ${cacheAgency}`,
			`PublishedAt: ${cachePublishedAt}`,
			`EventUri: ${cacheEventUri}`,
			'',
			String(extracted.text || ''),
		].join('\n')
	)
}

async function forceRefreshArticleTextForFacts(e, sourceUrl) {
	let baseUrl = normalizeHttpUrl(e.usedUrl || sourceUrl || e.url)
	if (!baseUrl) return ''

	log('FACTS refusal marker detected -> force re-extract article text', `url=${baseUrl}`)
	let extracted = await extractVerified(baseUrl)
	if (!extracted) {
		log('FACTS refusal: primary re-extract failed, trying another agency...')
		extracted = await tryOtherAgencies(e, baseUrl)
	}
	if (!extracted?.text) return ''

	e.usedUrl = extracted.url || baseUrl
	let refreshedAgency = cleanAgencyName(extracted.source)
	if (refreshedAgency) e.agency = refreshedAgency
	let refreshedDate = resolveStoryDate({
		sourceUrl: e.usedUrl || baseUrl,
		extractedPublishedAt: extracted.publishedAt,
	})
	if (refreshedDate) e.date = refreshedDate
	writeArticleCache(e.id, extracted, e.titleEn || e.titleRu || '')
	log('FACTS refusal: refreshed article text', `${extracted.text.length} chars`, `usedUrl=${e.usedUrl}`)
	return extracted.text
}

async function refreshAgency(e, sourceUrl) {
	let baseUrl = normalizeHttpUrl(sourceUrl || e.usedUrl || e.url)
	if (!baseUrl) {
		e.agency = ''
		return ''
	}

	let agency = cleanAgencyName(await extractArticleAgency(baseUrl))
	if (!agency) agency = cleanAgencyName(fallbackAgencyFromUrl(baseUrl))
	e.agency = agency
	if (agency) {
		log('Agency resolved', agency, `url=${baseUrl}`)
	} else {
		log('Agency unresolved', `url=${baseUrl}`)
	}
	return agency
}

async function refreshStoryDate(e, sourceUrl) {
	let baseUrl = normalizeHttpUrl(sourceUrl || e.usedUrl || e.url)
	if (!baseUrl) {
		e.date = ''
		return ''
	}

	let storyDate = normalizeRecentStoryDate(await extractArticleDate(baseUrl))
	if (!storyDate) storyDate = normalizeRecentStoryDate(inferDateFromUrl(baseUrl))
	e.date = storyDate
	if (storyDate) {
		log('Date resolved', storyDate, `url=${baseUrl}`)
	} else {
		log('Date unresolved', `url=${baseUrl}`)
	}
	return storyDate
}

function processingNeeds(e) {
	let hasReadyTitle = hasMeaningfulText(e.titleEn) || hasMeaningfulText(e.titleRu)
	let hasReadySummary = hasMeaningfulText(e.summary)
	let needsTitleEn = !hasMeaningfulText(e.titleEn)
	let needsSummary = !hasMeaningfulText(e.summary)
	let needsFacts = !hasMeaningfulFacts(e.factsRu)
	let needsTalkingPoints = !hasMeaningfulText(e.arguments)
	let needsVideos = !hasVideoLinks(e.videoUrls) && !(hasReadyTitle && hasReadySummary)
	let needsDate = !hasMeaningfulText(e.date)
	let needsUsedUrl = !hasMeaningfulText(e.usedUrl)
	let needsAgency = !hasMeaningfulText(e.agency) && hasResolvableAgencyInput(e)

	let missing = []
	if (needsTitleEn) missing.push('titleEn')
	if (needsSummary) missing.push('summary')
	if (needsAgency) missing.push('agency')
	if (needsFacts) missing.push('factsRu')
	if (needsTalkingPoints) missing.push('arguments')
	if (needsVideos) missing.push('videoUrls')
	if (needsDate) missing.push('date')
	if (needsUsedUrl) missing.push('usedUrl')

	return {
		needsTitleEn,
		needsSummary,
		needsFacts,
		needsTalkingPoints,
		needsVideos,
		needsDate,
		needsUsedUrl,
		needsAgency,
		needsContent: needsSummary || needsFacts || needsTalkingPoints || needsVideos,
		missing,
	}
}

function processingDecision(e) {
	if (e.topic === 'other') {
		return { shouldProcess: false, reason: 'topic=other', missing: [] }
	}
	let needs = processingNeeds(e)
	if (!needs.missing.length) {
		return { shouldProcess: false, reason: 'already_complete', missing: [] }
	}
	return {
		shouldProcess: true,
		reason: `needs=${needs.missing.join(',')}`,
		missing: needs.missing,
	}
}

function collectDuplicateUrlGroups(rows) {
	let grouped = new Map()
	for (let e of rows || []) {
		let key = normalizeHttpUrl(e.usedUrl || e.url)
		if (!key) continue
		let bucket = grouped.get(key)
		if (!bucket) {
			bucket = []
			grouped.set(key, bucket)
		}
		bucket.push(e)
	}
	return [...grouped.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([url, group], idx) => ({ groupId: idx + 1, url, group }))
}

function markDuplicateUrls(rows) {
	for (let e of rows || []) {
		e.duplicateUrl = ''
	}

	let groups = collectDuplicateUrlGroups(rows)
	for (let g of groups) {
		let peerIds = uniq(g.group.map(e => String(e.id || '').trim()).filter(Boolean))
		let mark = `DUP_URL group=${g.groupId}; count=${g.group.length}; peer_ids=${peerIds.join(',')}; key=${g.url}`
		for (let e of g.group) {
			e.duplicateUrl = mark
		}
	}
	return groups
}

async function extractWithBrightData(url) {
	let info = await extractArticleWithBrightData(url, { logger: log })
	let text = normalizeText(info?.body)
	let publishedAt = normalizeDateIso(info?.publishedAt || info?.dateTime || info?.date)
	if (text.length > MIN_TEXT_LENGTH) {
		return {
			url,
			title: info?.title,
			text: text.slice(0, MAX_TEXT_LENGTH),
			html: info?.bodyHtml,
			publishedAt,
			source: cleanAgencyName(info?.source || fallbackAgencyFromUrl(url)),
			eventUri: '',
		}
	}
	if (text.length) {
		log('Bright Data extract too short', `${text.length} chars`, `url=${url}`)
	}
}

async function extractWithCurrentFlow(url) {
	for (let attempt = 0; attempt < 2; attempt++) {
		log(`Current extract attempt ${attempt + 1}/2...`)
		let info = await extractArticleInfo(url)
		let text = normalizeText(info?.body)
		let publishedAt = normalizeDateIso(info?.publishedAt || info?.dateTime || info?.date)
		if (text.length > MIN_TEXT_LENGTH) {
			return {
				url,
				title: info?.title,
				text: text.slice(0, MAX_TEXT_LENGTH),
				html: info?.bodyHtml,
				publishedAt,
				source: cleanAgencyName(info?.source),
				eventUri: String(info?.eventUri || '').trim(),
			}
		}
		if (attempt === 0) log('No current-flow text extracted, retrying...')
	}
}

async function extractVerified(url, { allowBrightData = true, allowCurrentFlow = true } = {}) {
	if (allowBrightData) {
		let extracted = await extractWithBrightData(url)
		if (extracted) return extracted
	}
	if (allowCurrentFlow) {
		return await extractWithCurrentFlow(url)
	}
}

async function decodeWithThrottle(last, gnUrl, label = 'Decoding URL...') {
	await sleep(last.urlDecode.time + last.urlDecode.delay - Date.now(), 'google_news_decode_throttle')
	last.urlDecode.delay += last.urlDecode.increment
	last.urlDecode.time = Date.now()
	log(label)
	// Deprecated: gnUrl decode is kept only for legacy rows that still store Google News redirect URLs.
	return await decodeGoogleNewsUrl(gnUrl)
}

function saveAlternativeUrls(e, sourceUrl, candidates, stageLabel) {
	let currentUrl = normalizeHttpUrl(sourceUrl)
	let alternativeUrls = uniq(
		(candidates || [])
			.map(a => normalizeHttpUrl(a?.url))
			.filter(Boolean)
			.filter(url => !currentUrl || url !== currentUrl)
	)
	if (!alternativeUrls.length) return
	e.alternativeUrls = mergeUrlLines(e.alternativeUrls, alternativeUrls)
	log(`${stageLabel} saved alternative URLs`, alternativeUrls.length)
}

async function selectFallbackCandidate({
	e,
	sourceUrl,
	candidates,
	searchKeywords,
	keywordsForMatch,
	strictKeywords,
	stageLabel,
}) {
	if (!Array.isArray(candidates) || !candidates.length) return

	log(`${stageLabel} candidates`, candidates.length)
	saveAlternativeUrls(e, sourceUrl, candidates, stageLabel)

	let baseSource = (e.source || '').trim().toLowerCase()
	let baseHost = ''
	try { baseHost = new URL(sourceUrl).hostname } catch {}

	let minMatchHits = Math.min(2, keywordsForMatch.length)
	let maxTries = 7
	let tries = 0
	let best = null

	for (let a of candidates) {
		if (tries >= maxTries) break
		let url = normalizeHttpUrl(a?.url)
		if (!url || url === sourceUrl) continue
		if (baseSource && a.source && a.source.trim().toLowerCase() === baseSource) continue
		if (baseHost) {
			try {
				if (new URL(url).hostname === baseHost) continue
			} catch {}
		}

		let meta = `${a?.title || ''}\n${url}`
		let metaHits = countKeywordHits(meta, searchKeywords)
		let strictMetaHits = countKeywordHits(meta, strictKeywords)
		let eventUri = a?.eventUri

		log(
			`Trying ${stageLabel} candidate`,
			a.source || '',
			eventUri ? `eventUri=${eventUri}` : '',
			a.reason ? `reason=${a.reason}` : '',
			`metaHits=${metaHits}/${searchKeywords.length}`,
			`url=${url}`,
		)
		tries++

		log(`Extracting ${stageLabel} article...`, a.source || '', `url=${url}`)
		let extracted = await extractVerified(url)
		if (!extracted) continue

		let title = extracted.title || ''
		let haystack = `${title}\n${extracted.text || ''}`
		let totalHits = countKeywordHits(haystack, keywordsForMatch)
		if (keywordsForMatch.length && totalHits < minMatchHits) {
			log(`Skipping ${stageLabel} (low relevance)`, a.source || '', `hits=${totalHits}/${keywordsForMatch.length}`, `url=${url}`)
			continue
		}

		let strictHits = countKeywordHits(haystack, strictKeywords)
		if (strictKeywords.length && strictHits < 1 && strictMetaHits < 1) {
			log(`Skipping ${stageLabel} (strict mismatch)`, a.source || '', `strict_hits=${strictHits}/${strictKeywords.length}`, `url=${url}`)
			continue
		}

		let score = totalHits * 10 + strictHits * 25 + metaHits * 5 + strictMetaHits * 10
		if (!best || score > best.score) {
			best = { score, extracted, source: a.source || '', url }
		}
	}

	if (!best?.extracted) return

	log(`${stageLabel} selected`, best.source || '', `score=${best.score}`, `url=${best.url}`)
	return {
		...best.extracted,
		source: cleanAgencyName(best.extracted?.source || best.source),
	}
}

async function tryOtherAgencies(e, primaryUrl) {
	let sourceUrl = normalizeHttpUrl(primaryUrl || e.url)
	if (!sourceUrl) return

	let keywordsAll = urlKeywords(sourceUrl, FALLBACK_MAX_KEYWORDS)
	let keywords = keywordsAll.filter(k => k.length >= 4)
	if (keywords.length < 2) keywords = keywordsAll
	if (!keywords.length) {
		log('No URL keywords for fallback search')
		return
	}

	log(`Fallback URL keywords (${keywords.length}):`, keywords.join(' '))
	log('Extracting fallback keywords...', describeFallbackKeywordsSettings())
	let aiKeywords = await extractFallbackKeywords(sourceUrl, keywords, 8)
	if (aiKeywords.length) log(`Fallback AI keywords (${aiKeywords.length}):`, aiKeywords.join(' '))
	let searchKeywords = aiKeywords.length ? aiKeywords : keywords
	log(`Fallback search keywords (${searchKeywords.length}):`, searchKeywords.join(' '))
	let keywordsForMatch = keywords
	if (keywordsForMatch.length) log('Fallback relevance keywords:', keywordsForMatch.join(' '))
	let strictKeywords = storyStrictKeywords(e, sourceUrl)
	if (strictKeywords.length) log('Fallback strict keywords:', strictKeywords.join(' '))

	log('Looking up GPT alternative URLs...', describeAlternativeUrlLookupSettings())
	let gptCandidates = await collectAlternativeUrlsByStory({
		url: sourceUrl,
		titleEn: e.titleEn,
		titleRu: e.titleRu,
		source: e.source,
		keywords: searchKeywords,
		strictKeywords,
		date: e.date,
	}, { logger: log })
	let gptSelected = await selectFallbackCandidate({
		e,
		sourceUrl,
		candidates: gptCandidates,
		searchKeywords,
		keywordsForMatch,
		strictKeywords,
		stageLabel: 'gpt_fallback',
	})
	if (gptSelected) return gptSelected

	log('GPT fallback did not resolve article, trying current direct flow...')
	let directCurrent = await extractVerified(sourceUrl, { allowBrightData: false, allowCurrentFlow: true })
	if (directCurrent) {
		log('Current direct flow recovered original URL', `url=${sourceUrl}`)
		return directCurrent
	}

	let candidates = await findAlternativeArticles(sourceUrl, { keywords: searchKeywords })
	if (!candidates.length) {
		log('No current-flow alternative articles found')
		return
	}

	return await selectFallbackCandidate({
		e,
		sourceUrl,
		candidates,
		searchKeywords,
		keywordsForMatch,
		strictKeywords,
		stageLabel: 'current_fallback',
	})
}

export async function summarize() {
	migrateArgumentsColumn(news)
	ensureColumns(news, ['agency', 'date', 'url', 'usedUrl', 'alternativeUrls', 'factsRu', 'arguments', 'videoUrls', 'duplicateUrl'])

	news.forEach((e, i) => e.id ||= i + 1)

	let rows = news.map((e, rowIndex) => {
		let decision = processingDecision(e)
		let dedupeKey = normalizeHttpUrl(e.url || e.usedUrl)
		// Deprecated: gnUrl remains only as a fallback dedupe key for legacy rows.
		if (!dedupeKey && e.gnUrl) dedupeKey = String(e.gnUrl).trim()
		return { e, rowIndex, dedupeKey, ...decision }
	})
	let runRows = rows.filter(row => row.shouldProcess)
	for (let i = 0; i < runRows.length; i++) {
		runRows[i].runIndex = i + 1
	}
	let firstRunIndexByDedupeKey = new Map()
	for (let row of runRows) {
		if (!row.dedupeKey) continue
		let firstRunIndex = firstRunIndexByDedupeKey.get(row.dedupeKey)
		if (firstRunIndex != null) {
			row.skipReason = `duplicate_of_row=${firstRunIndex}`
			row.e.agency = ''
			row.e.factsRu = ''
			row.e.arguments = ''
			row.e.videoUrls = ''
			row.e.date = ''
			continue
		}
		firstRunIndexByDedupeKey.set(row.dedupeKey, row.runIndex)
	}
	let list = runRows.filter(row => !row.skipReason)
	let skipped = runRows.filter(row => !!row.skipReason)
	log('SUMMARIZE_REFRESH', 'dedupe=on', 'always=agency,date')
	log(
		'SUMMARIZE_ROWS',
		`total=${runRows.length}`,
		`to_process=${list.length}`,
		`skipped=${skipped.length}`,
	)
	let skippedByReason = {}
	for (let row of skipped) {
		skippedByReason[row.skipReason] = (skippedByReason[row.skipReason] || 0) + 1
		let title = row.e.titleEn || row.e.titleRu || ''
		log(
			`\n#${row.runIndex} [${row.runIndex}/${runRows.length}] SKIP`,
			`reason=${row.skipReason}`,
			title,
		)
	}
	let skippedReasonParts = Object.entries(skippedByReason)
		.map(([reason, count]) => `${reason}=${count}`)
	if (skippedReasonParts.length) {
		log('SUMMARIZE_SKIP_REASONS', ...skippedReasonParts)
	}

	let stats = { ok: 0, fail: 0 }
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
		facts: { time: 0, delay: 0 },
		talkingPoints: { time: 0, delay: 0 },
		videos: { time: 0, delay: 0 },
	}
	for (let i = 0; i < list.length; i++) {
		let row = list[i]
		let e = row.e
		log(
			`\n#${row.runIndex} [${row.runIndex}/${runRows.length}]`,
			`work=${i + 1}/${list.length}`,
			`reason=${row.reason}`,
			e.titleEn || e.titleRu || '',
		)
		let articleText = ''
		let articleHtml = ''
		let articleTitle = ''
		let sourceUrl = normalizeHttpUrl(e.url)
		let previousUsedUrl = normalizeHttpUrl(e.usedUrl)
		let needsAtStart = processingNeeds(e)
		let triedDateRefresh = false

		if (!sourceUrl /*&& !restricted.includes(e.source)*/) {
			// Deprecated: gnUrl fallback exists only to support legacy rows without a direct article URL.
			if (!e.gnUrl) {
				let canFallbackTalkingPointsOnly = needsAtStart.needsTalkingPoints
					&& !needsAtStart.needsSummary
					&& !needsAtStart.needsFacts
					&& !needsAtStart.needsVideos
				if (!canFallbackTalkingPointsOnly) {
					log('SKIP processing: missing url and gnUrl')
					stats.fail++
					continue
				}
				log('No url/gnUrl, fallback to existing fields for talking points')
			} else {
				// Deprecated: gnUrl decode path exists only for legacy rows without a direct article URL.
				sourceUrl = await decodeWithThrottle(last, e.gnUrl)
				if (!sourceUrl) {
					await sleep(5*60e3, 'summarize_missing_decoded_url_retry')
					i--
					continue
				}
				log('got', sourceUrl)
			}
		}
			if (sourceUrl) {
				// Always keep the actually used source URL:
				// start with original URL, then overwrite with fallback URL if selected later.
				e.usedUrl = sourceUrl
				let cachedArticle = readCachedArticle(e.id, sourceUrl)
					if (cachedArticle?.agency) e.agency = cachedArticle.agency
					if (cachedArticle?.publishedAt) e.date = normalizeRecentStoryDate(cachedArticle.publishedAt)
					articleTitle = String(cachedArticle?.title || '').trim()
					if (cachedArticle?.title) e.titleEn ||= cachedArticle.title
					articleText = cachedArticle?.text || ''
					articleHtml = String(cachedArticle?.html || '').trim()
					if (articleText.length > MIN_TEXT_LENGTH) {
					log('Using cached article text', `id=${e.id}`, `${articleText.length} chars`)
				}
			}

		let sourceChanged = !!(sourceUrl && previousUsedUrl && previousUsedUrl !== sourceUrl)
		if (sourceChanged) {
			log('Source URL changed for row -> forcing full refresh', `prev=${previousUsedUrl}`, `now=${sourceUrl}`)
			e.summary = ''
			e.factsRu = ''
			e.arguments = ''
			e.videoUrls = ''
			e.date = ''
			e.agency = ''
		}

		const initialNeeds = processingNeeds(e)
		const needsTextWork = initialNeeds.needsContent
		const shouldRefreshAgencyViaLookup = !!sourceUrl
			&& !hasMeaningfulText(e.agency)
			&& (articleText.length > MIN_TEXT_LENGTH || !needsTextWork)
		if (shouldRefreshAgencyViaLookup) {
			await refreshAgency(e, e.usedUrl || sourceUrl)
		}
		const shouldRefreshDateViaLookup = !!sourceUrl
			&& !hasMeaningfulText(e.date)
			&& (articleText.length > MIN_TEXT_LENGTH || !needsTextWork)
		if (shouldRefreshDateViaLookup) {
			triedDateRefresh = true
			await refreshStoryDate(e, e.usedUrl || sourceUrl)
		}
		if (sourceUrl && needsTextWork && articleText.length <= MIN_TEXT_LENGTH) {
			log('Extracting article via Bright Data exact URL...', describeBrightDataArticleExtractionSettings(), `url=${sourceUrl}`)
			let extracted = await extractVerified(sourceUrl, { allowBrightData: true, allowCurrentFlow: false })
			if (!extracted) {
				log('Bright Data exact URL failed, trying GPT/current fallbacks...')
				extracted = await tryOtherAgencies(e, sourceUrl)
			}
			if (extracted) {
				e.usedUrl = extracted.url || sourceUrl
				let resolvedAgency = cleanAgencyName(extracted.source)
				if (resolvedAgency) {
					e.agency = resolvedAgency
				} else {
					await refreshAgency(e, e.usedUrl || sourceUrl)
				}
				let fallbackUsed = normalizeHttpUrl(e.usedUrl) && normalizeHttpUrl(sourceUrl) && normalizeHttpUrl(e.usedUrl) !== normalizeHttpUrl(sourceUrl)
				if (fallbackUsed && extracted.title) {
					articleTitle = extracted.title
					e.titleEn = extracted.title
					e.titleRu = ''
				} else if (extracted.title) {
					articleTitle = extracted.title
					e.titleEn ||= extracted.title
				}
				let resolvedDate = resolveStoryDate({
					sourceUrl: e.usedUrl || sourceUrl,
					extractedPublishedAt: extracted.publishedAt,
				})
					if (resolvedDate) e.date = resolvedDate
					log('got', extracted.text.length, 'chars')
					articleText = extracted.text
					articleHtml = String(extracted.html || '').trim()
					writeArticleCache(e.id, extracted, e.titleEn || e.titleRu || '')
				} else {
					await refreshAgency(e, e.usedUrl || sourceUrl)
				}
			}
		if (sourceUrl && initialNeeds.needsTitleEn && !hasMeaningfulText(e.titleEn)) {
			log('TitleEn is missing. Trying URL title lookup...', describeTitleLookupSettings())
			try {
				let lookedUp = await collectTitleByUrl({ url: e.usedUrl || sourceUrl || e.url })
				if (lookedUp?.titleEn || lookedUp?.titleRu) {
					e.titleEn ||= lookedUp.titleEn
					e.titleRu ||= lookedUp.titleRu
					log('Title lookup done', `titleEn=${lookedUp.titleEn ? 'yes' : 'no'}`, `titleRu=${lookedUp.titleRu ? 'yes' : 'no'}`)
				} else {
					log('Title lookup failed (empty title)')
				}
				if (lookedUp?.extra) {
					log('Title lookup extra:', lookedUp.extra)
				}
			} catch (err) {
				log('Title lookup failed', err?.message || err)
			}
		}
		if (!hasMeaningfulText(e.date) && sourceUrl && !triedDateRefresh) {
			triedDateRefresh = true
			await refreshStoryDate(e, e.usedUrl || sourceUrl)
		}

			const currentNeeds = processingNeeds(e)
			const talkingPointsInput = buildTalkingPointsInput({
				articleText,
				titleEn: e.titleEn,
				titleRu: e.titleRu,
				summary: e.summary,
				factsRu: e.factsRu,
				agency: resolveSummaryAttributionSource(e),
				url: e.usedUrl || sourceUrl || e.url,
			})
			const shouldSummarize = articleText.length > 400 && currentNeeds.needsSummary
			const shouldCollectFacts = articleText.length > MIN_TEXT_LENGTH && currentNeeds.needsFacts
			const shouldCollectTalkingPoints = hasMeaningfulText(talkingPointsInput)
				&& currentNeeds.needsTalkingPoints
			const shouldCollectVideos = articleText.length > MIN_TEXT_LENGTH && currentNeeds.needsVideos

			if (shouldSummarize || shouldCollectFacts || shouldCollectTalkingPoints || shouldCollectVideos) {
				let enrichInput = { ...e, url: e.usedUrl || sourceUrl || e.url, text: articleText, html: articleHtml, articleTitle }
				let tasks = []
				const makeLogger = (taskName) => (...params) => log(`[${taskName}]`, ...params)
				const traceTask = (name, runner) => async () => {
					let startedAt = Date.now()
					log(`Task ${name} started`)
					try {
						return await runner()
					} finally {
						log(`Task ${name} finished`, `ms=${Date.now() - startedAt}`)
					}
				}

			if (shouldSummarize) {
				log('Summarizing', articleText.length, 'chars...')
				let task = {
					name: 'summary',
					run: traceTask('summary', async () => {
						await sleep(last.ai.time + last.ai.delay - Date.now(), 'summary_throttle')
						last.ai.time = Date.now()
						return await ai({
							url: e.usedUrl || sourceUrl || e.url,
							agency: resolveSummaryAttributionSource(e),
							text: articleText,
							logger: makeLogger('summary'),
						})
					})
				}
				tasks.push(task)
			}

			if (shouldCollectFacts) {
				log('Collecting facts...', describeFactsSettings())
				let task = {
					name: 'facts',
					run: traceTask('facts', async () => {
						await sleep(last.facts.time + last.facts.delay - Date.now(), 'facts_throttle')
						last.facts.time = Date.now()
						return await collectFacts(enrichInput, { logger: makeLogger('facts') })
					})
				}
				tasks.push(task)
			}

			if (shouldCollectTalkingPoints) {
				log('Collecting talking points...', describeTalkingPointsSettings())
				let task = {
					name: 'talking_points',
					run: traceTask('talking_points', async () => {
						await sleep(last.talkingPoints.time + last.talkingPoints.delay - Date.now(), 'talking_points_throttle')
						last.talkingPoints.time = Date.now()
						return await collectTalkingPoints(
							{ ...enrichInput, text: talkingPointsInput },
							{ logger: makeLogger('talking_points') }
						)
					})
				}
				tasks.push(task)
			}

			if (shouldCollectVideos) {
				log('Collecting videos...', describeVideosSettings())
				let task = {
					name: 'videos',
					run: traceTask('videos', async () => {
						await sleep(last.videos.time + last.videos.delay - Date.now(), 'videos_throttle')
						last.videos.time = Date.now()
						return await collectVideos(enrichInput, { logger: makeLogger('videos') })
					})
				}
				tasks.push(task)
			}

			if (tasks.length > 1) {
				log('Running in parallel:', tasks.map(t => t.name).join(', '))
			}

			let results = await Promise.allSettled(tasks.map(t => t.run()))
			for (let i = 0; i < tasks.length; i++) {
				let task = tasks[i]
				let result = results[i]

				if (result.status === 'rejected') {
					log(`${task.name} failed`, result.reason?.message || result.reason || '')
					continue
				}

				if (task.name === 'summary') {
					let res = result.value
					if (res) {
						last.ai.delay = res.delay
						const normalizedTopic = normalizeTopic(topicsMap[res.topic] || res.topic || '')
						let normalizedSummary = ensureSummaryAttribution(res.summary, e)
						e.priority ||= res.priority
						e.titleRu ||= res.titleRu
						e.summary = normalizedSummary
						e.aiTopic = normalizedTopic || topicsMap[res.topic]
						e.aiPriority = res.priority
						if (normalizedSummary !== String(res.summary ?? '').trim()) {
							log('summary attribution appended')
						}
						log('summary done', `${String(normalizedSummary || '').length} chars`)
					} else {
						log('summary failed (empty result)')
					}
					continue
				}

				if (task.name === 'facts') {
					if (hasFactsRefusalMarker(result.value)) {
						log('facts failed (refusal marker)')
						let refreshedText = await forceRefreshArticleTextForFacts(e, sourceUrl)
						if (refreshedText.length > MIN_TEXT_LENGTH) {
							articleText = refreshedText
							let retryInput = { ...e, url: e.usedUrl || sourceUrl || e.url, text: articleText }
							log('Collecting facts retry after forced text refresh...', describeFactsSettings())
							await sleep(last.facts.time + last.facts.delay - Date.now(), 'facts_retry_throttle')
							last.facts.time = Date.now()
							let retryRaw = await collectFacts(retryInput, { logger: log })
							if (hasFactsRefusalMarker(retryRaw)) {
								log('facts failed again (refusal marker after refresh)')
								e.factsRu = ''
								continue
							}
							let retryFacts = normalizeFactsValue(retryRaw)
							if (retryFacts) {
								e.factsRu = retryFacts
								log('facts done after refresh', `${retryFacts.length} chars`)
							} else {
								e.factsRu = ''
								log('facts failed after refresh (empty result)')
							}
						} else {
							log('facts failed: could not refresh article text')
							e.factsRu = ''
						}
						continue
					}

					let factsRu = normalizeFactsValue(result.value)
					if (factsRu) {
						e.factsRu = factsRu
						log('facts done', `${factsRu.length} chars`)
					} else {
						log('facts failed (empty result)')
					}
					continue
				}

				if (task.name === 'talking_points') {
					let argumentsText = normalizeTalkingPointsValue(result.value)
					if (argumentsText) {
						e.arguments = argumentsText
						let stats = talkingPointsStats(argumentsText)
						if (stats.count !== TALKING_POINTS_MAX_ITEMS) {
							log('talking points format warning', `points=${stats.count}`, `expected=${TALKING_POINTS_MAX_ITEMS}`)
						}
						log('talking points words', ...stats.wordCounts.map((wc, idx) => `p${idx + 1}=${wc}`))
						log('talking points done', `${argumentsText.length} chars`)
					} else {
						log('talking points failed (empty result)')
					}
					continue
				}

				if (task.name === 'videos') {
					let videoUrls = normalizeVideoUrls(result.value)
					if (videoUrls) {
						e.videoUrls = videoUrls
						log('videos done', `${videoUrls.length} chars`)
					} else {
						log('videos failed (empty result)')
					}
				}
			}
		}

		if (!e.summary) {
			log('failed to summarize')
			stats.fail++
		} else {
			stats.ok++
		}
	}
	let attributionAutofixCount = 0
	for (let e of news) {
		let fixedSummary = ensureSummaryAttribution(e.summary, e)
		if (!fixedSummary || fixedSummary === String(e.summary ?? '').trim()) continue
		e.summary = fixedSummary
		attributionAutofixCount++
	}
	if (attributionAutofixCount) {
		log('SUMMARY_ATTRIBUTION_AUTOFIX', `updated=${attributionAutofixCount}`)
	}
	let duplicateGroups = markDuplicateUrls(news)
	let duplicateRows = duplicateGroups.reduce((sum, g) => sum + g.group.length, 0)
	log('SUMMARY_DUP_URL', `groups=${duplicateGroups.length}`, `rows=${duplicateRows}`)
	for (let g of duplicateGroups) {
		log(`SUMMARY_DUP_URL group=${g.groupId} count=${g.group.length} url=${g.url}`)
		for (let e of g.group) {
			log(
				'  row',
				`id=${e.id || ''}`,
				`sqk=${e.sqk || ''}`,
				`source=${e.source || ''}`,
				`title=${e.titleRu || e.titleEn || ''}`,
				`url=${normalizeHttpUrl(e.url) || String(e.url || '').trim()}`,
				`usedUrl=${normalizeHttpUrl(e.usedUrl) || String(e.usedUrl || '').trim()}`,
			)
		}
	}
	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))
	await save()

	log('\n', stats)
	logRunTotalCost({ task: 'summarize', logger: log })
	logRunApiStats({ task: 'summarize', logger: log })
}

if (process.argv[1].endsWith('summarize')) summarize()
