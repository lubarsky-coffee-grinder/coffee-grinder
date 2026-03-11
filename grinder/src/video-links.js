import OpenAI from 'openai'
import { OAuth2Client } from 'google-auth-library'

import { findAlternativeArticles } from './newsapi.js'
import { readEnv } from './env.js'
import { sleep } from './sleep.js'
import { spreadsheetId } from './store.js'
import { getPrompt } from './prompts.js'
import { estimateAndLogCost, trackApiRequest, trackApiResult } from './cost.js'
import { buildChatCompletionsRequest, buildResponsesWebSearchRequest } from './openai-request-templates.js'
import { extractResponseOutputText } from './openai-websearch-templates.js'

const MAX_CANDIDATE_PAGES = 8
const MAX_VIDEO_URLS = 1
const MAX_VIDEOS_PER_SOURCE = 1
const MAX_SOURCE_PAGES_TO_CHECK = 1
const SERPAPI_TIMEOUT_MS = 12e3
const SERPAPI_RETRY_DELAY_MS = 1500
const SERPAPI_COOLDOWN_MS = 60e3
const YOUTUBE_API_TIMEOUT_MS = 12e3
const YOUTUBE_API_RETRY_DELAY_MS = 1500
const YOUTUBE_RSS_TIMEOUT_MS = 10e3
const YOUTUBE_RSS_RETRY_DELAY_MS = 1200
const YOUTUBE_OEMBED_TIMEOUT_MS = 8e3
const YOUTUBE_WATCH_TIMEOUT_MS = 10e3
const PAGE_FETCH_TIMEOUT_MS = 10e3
const DATE_WINDOW_DAYS = 5
const FALLBACK_DATE_WINDOW_DAYS = 5
const YOUTUBE_UPLOADS_DEFAULT = 150
const YOUTUBE_UPLOADS_MIN = 100
const YOUTUBE_UPLOADS_MAX = 200
const YOUTUBE_VERIFY_VIDEOS_PER_SOURCE_DEFAULT = 4
const YOUTUBE_VERIFY_VIDEOS_PER_SOURCE_MIN = 1
const YOUTUBE_VERIFY_VIDEOS_PER_SOURCE_MAX = 8
const YOUTUBE_VERIFY_VIDEOS_PER_STORY_DEFAULT = 18
const YOUTUBE_VERIFY_VIDEOS_PER_STORY_MIN = 3
const YOUTUBE_VERIFY_VIDEOS_PER_STORY_MAX = 60
const YOUTUBE_SEARCH_RESULTS_PER_QUERY_DEFAULT = 12
const YOUTUBE_SEARCH_RESULTS_PER_QUERY_MIN = 3
const YOUTUBE_SEARCH_RESULTS_PER_QUERY_MAX = 25
const YOUTUBE_SEARCH_QUERIES_DEFAULT = 3
const YOUTUBE_SEARCH_QUERIES_MIN = 1
const YOUTUBE_SEARCH_QUERIES_MAX = 6
const DAY_MS = 24 * 60 * 60e3
const MIN_KEYWORD_HITS = 1
const VERIFY_SNIPPET_MAX_CHARS = 2500
const VERIFY_MIN_CONFIDENCE = 0.7
const VERIFY_TEMPERATURE = 0
const VERIFY_REASONING_EFFORT = 'medium'
const VIDEO_WEBSEARCH_REASONING_EFFORT = 'low'
const VIDEO_WEBSEARCH_TEMPERATURE = undefined
const VERIFY_VIDEO_DESCRIPTION_MAX_CHARS = 700
const MAX_VERIFY_VIDEOS_PER_PAGE = 6
const HOST_COOLDOWN_FAILURE_LIMIT = 2
const HOST_COOLDOWN_STATUS_CODES = new Set([401, 403, 429])

const VIDEO_VERIFY_DEFAULT_MODEL = 'gpt-4o-mini'
const explicitVideoVerifyModel = readEnv('OPENAI_VIDEO_VERIFY_MODEL')
const videoVerifyModel = explicitVideoVerifyModel || VIDEO_VERIFY_DEFAULT_MODEL
const VIDEO_WEBSEARCH_DEFAULT_MODEL = 'gpt-5.4'
const VIDEO_WEBSEARCH_PROMPT_NAME = 'summarize:videos'
const explicitVideoWebSearchModel = readEnv('OPENAI_VIDEO_WEBSEARCH_MODEL')
const videoWebSearchModel = explicitVideoWebSearchModel || VIDEO_WEBSEARCH_DEFAULT_MODEL
const VIDEO_WEBSEARCH_PARALLEL_REQUESTS = 3
const videoVerifyEnabled = process.env.VIDEO_GPT_VERIFY !== '0' && !!process.env.OPENAI_API_KEY
const videoWebSearchEnabled = process.env.VIDEO_GPT_WEBSEARCH !== '0' && !!process.env.OPENAI_API_KEY
const openai = (videoVerifyEnabled || videoWebSearchEnabled) ? new OpenAI() : null
let serpapiCooldownUntilMs = 0
let serpapiDisabledForRun = false
let serpapiDisabledReason = ''
let serpapiDisabledLogged = false
const youtubeSourceCache = new Map()
const youtubeRssSourceCache = new Map()
const youtubeRssFeedCache = new Map()
const youtubeMetadataCache = new Map()
const youtubeApiEnabledByConfig = readEnv('YOUTUBE_API_ENABLED') === '1'
const youtubeClientId = readEnv('GOOGLE_CLIENT_ID')
const youtubeClientSecret = readEnv('GOOGLE_CLIENT_SECRET')
const youtubeRefreshToken = readEnv('GOOGLE_REFRESH_TOKEN')
const youtubeOauthEnabled = youtubeApiEnabledByConfig && !!(youtubeClientId && youtubeClientSecret && youtubeRefreshToken)
const youtubeOauthClient = youtubeOauthEnabled
	? new OAuth2Client(youtubeClientId, youtubeClientSecret)
	: null
if (youtubeOauthClient) {
	youtubeOauthClient.setCredentials({ refresh_token: youtubeRefreshToken })
}
let youtubeAuthBroken = false
let youtubeAuthBrokenReason = ''
let youtubeAuthBrokenLogged = false
let youtubeApiDisabledByConfigLogged = false

function toSafeInt(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
	let n = Number(value)
	if (!Number.isFinite(n)) n = fallback
	n = Math.trunc(n)
	if (n < min) n = min
	if (n > max) n = max
	return n
}

const YOUTUBE_UPLOADS_PER_SOURCE = toSafeInt(
	process.env.YOUTUBE_UPLOADS_PER_SOURCE,
	YOUTUBE_UPLOADS_DEFAULT,
	{ min: YOUTUBE_UPLOADS_MIN, max: YOUTUBE_UPLOADS_MAX }
)

const YOUTUBE_VERIFY_VIDEOS_PER_SOURCE = toSafeInt(
	process.env.YOUTUBE_VERIFY_VIDEOS_PER_SOURCE,
	YOUTUBE_VERIFY_VIDEOS_PER_SOURCE_DEFAULT,
	{ min: YOUTUBE_VERIFY_VIDEOS_PER_SOURCE_MIN, max: YOUTUBE_VERIFY_VIDEOS_PER_SOURCE_MAX }
)

const YOUTUBE_VERIFY_VIDEOS_PER_STORY = toSafeInt(
	process.env.YOUTUBE_VERIFY_VIDEOS_PER_STORY,
	YOUTUBE_VERIFY_VIDEOS_PER_STORY_DEFAULT,
	{ min: YOUTUBE_VERIFY_VIDEOS_PER_STORY_MIN, max: YOUTUBE_VERIFY_VIDEOS_PER_STORY_MAX }
)

const YOUTUBE_SEARCH_RESULTS_PER_QUERY = toSafeInt(
	process.env.YOUTUBE_SEARCH_RESULTS_PER_QUERY,
	YOUTUBE_SEARCH_RESULTS_PER_QUERY_DEFAULT,
	{ min: YOUTUBE_SEARCH_RESULTS_PER_QUERY_MIN, max: YOUTUBE_SEARCH_RESULTS_PER_QUERY_MAX }
)

const YOUTUBE_SEARCH_QUERIES = toSafeInt(
	process.env.YOUTUBE_SEARCH_QUERIES,
	YOUTUBE_SEARCH_QUERIES_DEFAULT,
	{ min: YOUTUBE_SEARCH_QUERIES_MIN, max: YOUTUBE_SEARCH_QUERIES_MAX }
)

const YOUTUBE_OPEN_FALLBACK_ENABLED = process.env.YOUTUBE_OPEN_FALLBACK !== '0'
const VIDEO_WEBSEARCH_MAX_CANDIDATES = toSafeInt(
	process.env.VIDEO_GPT_WEBSEARCH_MAX_CANDIDATES,
	8,
	{ min: 1, max: 20 }
)

const VIDEO_VERIFY_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'video_candidates_relevance',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				decisions: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							videoUrl: { type: 'string' },
							match: { type: 'boolean' },
							confidence: { type: 'number', minimum: 0, maximum: 1 },
							reason: { type: 'string' },
						},
						required: ['videoUrl', 'match', 'confidence', 'reason'],
					},
				},
			},
			required: ['decisions'],
		},
		strict: true,
	},
}

const VIDEO_WEBSEARCH_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'video_websearch_candidates',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				videos: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							url: { type: 'string' },
							source: { type: 'string' },
							title: { type: 'string' },
							publishedAt: { type: 'string' },
						},
						required: ['url', 'source', 'title', 'publishedAt'],
					},
					minItems: 0,
					maxItems: VIDEO_WEBSEARCH_MAX_CANDIDATES,
				},
			},
			required: ['videos'],
		},
		strict: true,
	},
}

const TRUSTED_VIDEO_SOURCES = [
	'Reuters',
	'Sky News',
	'Guardian News',
	'New York Post',
	'Forbes Breaking News',
	'Firstpost',
	'NewsX World',
]

const VIDEO_SOURCE_DOMAINS = {
	'Forbes Breaking News': ['forbes.com'],
	'Sky News': ['news.sky.com', 'skynews.com.au'],
	'Reuters': ['reuters.com'],
	'New York Post': ['nypost.com'],
	'Guardian News': ['theguardian.com'],
	'Firstpost': ['firstpost.com'],
	'NewsX World': ['newsx.com'],
}

const TRUSTED_DOMAIN_LIST = Object.values(VIDEO_SOURCE_DOMAINS)
	.flat()
	.map(v => String(v || '').toLowerCase())
	.filter(Boolean)

const EXCLUDED_YOUTUBE_CHANNEL_PATTERNS = [
	/\bal[\s_-]*jazeera\b/i,
]

const YOUTUBE_CHANNEL_ALLOWLIST_TERMS = [
	// USA
	'forbes',
	'forbes breaking news',
	'fox news',
	'livenow from fox',
	'fox business',
	'cnn',
	'nbc news',
	'nbcnews',
	'cnbc television',
	'abc news',
	'cbs news',
	'cbs mornings',
	'usa today',
	'pbs newshour',
	'the wall street journal',
	'the new yorker',
	'the washington examiner',
	'vox',
	'the white house',
	'democracy now',

	// USA local
	'abc7 news bay area',
	'abc15 arizona',
	'cbs texas',
	'cbs chicago',
	'cbs new york',
	'first alert 6',
	'11alive',
	'kare 11',
	'wfaa',
	'kvue',
	'ksat 12',
	'waay 31 news',
	'wkmg news 6 clickorlando',
	'wplg local 10',
	'komo news',
	'we are iowa local 5 news',
	'wqad news 8',

	// UK / Europe
	'sky news',
	'sky news australia',
	'bbc news',
	'bbc world service',
	'the economist',
	'channel 4 news',
	'the guardian',
	'guardian news',
	'reuters',
	'bloomberg television',
	'dw news',
	'euronews',

	// India / South Asia
	'wion',
	'hindustan times',
	'times of india',
	'the indian express',
	'express tribune',
	'india today global',
	'business today',
	'et now',
	'et now world',
	'times now',
	'times now world',
	'republic world',
	'firstpost',
	'oneindia news',
	'indiatimes',
	'midday india',
	'dnaindianews',
	'mint',
	'the free press journal',
	'news9live',
	'news 15',
	'mirror now',

	// East Asia
	'south china morning post',
	'taiwanplus news',

	// Ukraine
	'ukrinform',
	'kyiv independent',
	'уніан',
	'unian',
	'тсн',
	'tsn',
	'24 канал',
	'київ24',
	'киев24',
	'телеканал київ',
	'freedom',
	'freedom live',
	'nexta live',

	// Russian-speaking independent
	'телеканал дождь',
	'дождь',
	'tvrain',
	'настоящее время',
	'current time',
	'navalny live',
	'навальный live',
	'вот так',
	'trt на русском',
	'trt russian',

	// Caucasus / Middle East
	'baku tv',
	'bakutvru',
	'newarab',
	'crux',
	'apt',

	// Other
	'the military show',
	'war vault',
	'the star',
	'the sun',
	'new york post',
	'the mirror',
	'newsx world',
	'newsx live',
	'news-tltv',
	'ms now',
	'delfi литва',
	'delfi lithuania',
	'africanews',
	'báo sức khỏe & đời sống',
	'kanal 13',
	'ani news',
	'dawnnews english',
]

function escapeRegexLiteral(text) {
	return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeAllowlistRegex(term) {
	let cleaned = String(term || '')
		.toLowerCase()
		.replace(/[|/\\_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (!cleaned) return null
	let escaped = escapeRegexLiteral(cleaned).replace(/\s+/g, '\\s+')
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu')
}

const YOUTUBE_CHANNEL_ALLOWLIST_REGEXES = YOUTUBE_CHANNEL_ALLOWLIST_TERMS
	.map(makeAllowlistRegex)
	.filter(Boolean)

const YOUTUBE_SOURCE_HANDLES = {
	'Forbes Breaking News': ['ForbesBreakingNews'],
	'Sky News': ['SkyNews'],
	'Reuters': ['Reuters'],
	'New York Post': ['nypost'],
	'Guardian News': ['GuardianNews'],
	'Firstpost': ['Firstpost'],
	'NewsX World': ['NewsXWorld', 'NewsXTV', 'NewsX'],
}

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'over', 'under',
	'about', 'after', 'before', 'between', 'while', 'where', 'when', 'what', 'which', 'whose',
	'of', 'in', 'on', 'at', 'to', 'as', 'by', 'via', 'per', 'than',
	'also', 'other', 'more', 'most', 'some', 'than', 'then', 'they', 'them', 'their', 'there',
	'you', 'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its', 'it', 'are', 'was', 'were',
	'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'not', 'but', 'have', 'has',
	'had', 'been', 'being', 'new', 'news', 'latest', 'update', 'live', 'video', 'watch', 'read',
	'world', 'us', 'usa', 'uk', 'eu', 'article',
])

const NOISY_KEYWORD_TOKENS = new Set([
	'featured',
	'independently',
	'selected',
	'editors',
	'writers',
	'preferred',
	'source',
	'sources',
	'story',
	'stories',
	'google',
	'endorse',
	'worthwhile',
	'something',
	'products',
	'cohost',
	'welcomed',
])

function uniq(list) {
	let seen = new Set()
	let out = []
	for (let v of list || []) {
		if (!v) continue
		if (seen.has(v)) continue
		seen.add(v)
		out.push(v)
	}
	return out
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

function uniqByUrl(list) {
	let seen = new Set()
	let out = []
	for (let item of list || []) {
		let url = normalizeHttpUrl(item?.url || item)
		if (!url) continue
		if (seen.has(url)) continue
		seen.add(url)
		if (typeof item === 'string') {
			out.push({ url, source: '', title: '', publishedAt: '' })
			continue
		}
		out.push({ ...item, url })
	}
	return out
}

function parseUrlLines(value) {
	return String(value ?? '')
		.replace(/\r/g, '\n')
		.split(/\n|,/g)
		.map(v => normalizeHttpUrl(v))
		.filter(Boolean)
}

function hostFromUrl(value) {
	try {
		return new URL(String(value).trim()).hostname.toLowerCase().replace(/^www\./, '')
	} catch {
		return ''
	}
}

function resolveTrustedSourceByUrl(url) {
	let host = hostFromUrl(url)
	if (!host) return ''
	for (let [source, domains] of Object.entries(VIDEO_SOURCE_DOMAINS)) {
		for (let base of domains || []) {
			let normalized = String(base || '').toLowerCase().replace(/^www\./, '')
			if (!normalized) continue
			if (host === normalized || host.endsWith(`.${normalized}`)) return source
		}
	}
	return ''
}

function isTrustedSourcePage(url) {
	return !!resolveTrustedSourceByUrl(url)
}

function isExcludedChannelText(value) {
	let text = String(value || '').trim().toLowerCase()
	if (!text) return false
	return EXCLUDED_YOUTUBE_CHANNEL_PATTERNS.some(rx => rx.test(text))
}

function normalizeChannelText(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/[|/\\_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function isAllowlistedChannelText(value) {
	let text = normalizeChannelText(value)
	if (!text) return false
	return YOUTUBE_CHANNEL_ALLOWLIST_REGEXES.some(rx => rx.test(text))
}

function isAllowlistedVideoByChannel({ source, channelTitle, author } = {}) {
	return isAllowlistedChannelText(author)
		|| isAllowlistedChannelText(channelTitle)
		|| isAllowlistedChannelText(source)
}

function isExcludedVideoByChannel({ source, channelTitle, author } = {}) {
	return isExcludedChannelText(author)
		|| isExcludedChannelText(channelTitle)
		|| isExcludedChannelText(source)
}

function parseDateValue(value) {
	if (value == null || value === '') return NaN
	if (value instanceof Date) {
		let ms = value.getTime()
		return Number.isFinite(ms) ? ms : NaN
	}
	if (typeof value === 'number') {
		let ms = value
		if (ms > 0 && ms < 1e11) ms *= 1000
		return Number.isFinite(ms) ? ms : NaN
	}

	let text = String(value).trim()
	if (!text) return NaN

	let d = new Date(text)
	if (Number.isFinite(d.getTime())) return d.getTime()

	let compact = text.match(/^(\d{4})(\d{2})(\d{2})$/)
	if (compact) {
		let normalized = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`)
		if (Number.isFinite(normalized.getTime())) return normalized.getTime()
	}

	return NaN
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

function buildValidatedDateMs(year, month, day = 1) {
	let y = Number(year)
	let m = Number(month)
	let d = Number(day)
	if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN
	if (m < 1 || m > 12 || d < 1 || d > 31) return NaN

	let resolved = new Date(Date.UTC(y, m - 1, d))
	if (!Number.isFinite(resolved.getTime())) return NaN
	if (resolved.getUTCFullYear() !== y || resolved.getUTCMonth() !== m - 1 || resolved.getUTCDate() !== d) return NaN
	return resolved.getTime()
}

function parseDateFromUrl(value) {
	let url = String(value || '')
	if (!url) return NaN

	let withDelimiters = url.match(/(?:\/|[-_])((?:19|20)\d{2})[-_/]((?:0?[1-9]|1[0-2]))[-_/]((?:0?[1-9]|[12]\d|3[01]))(?:\/|[-_]|$)/)
	if (withDelimiters) {
		return buildValidatedDateMs(withDelimiters[1], withDelimiters[2], withDelimiters[3])
	}

	let compact = url.match(/(?:\/|[-_])((?:19|20)\d{2})([01]\d)([0-3]\d)(?:\/|[-_]|$)/)
	if (compact) {
		return buildValidatedDateMs(compact[1], compact[2], compact[3])
	}

	let withNamedMonth = url.match(/(?:\/|[-_])((?:19|20)\d{2})[-_/]([a-z]{3,9})[-_/]((?:0?[1-9]|[12]\d|3[01]))(?:\/|[-_]|$)/i)
	if (withNamedMonth) {
		let month = monthNumberFromToken(withNamedMonth[2])
		if (month) return buildValidatedDateMs(withNamedMonth[1], month, withNamedMonth[3])
	}

	return NaN
}

function candidateDateMs(candidate) {
	let ms = parseDateValue(candidate?.publishedAt)
	if (Number.isFinite(ms)) return ms
	return parseDateFromUrl(candidate?.url)
}

function isWithinDateWindow(candidateMs, originMs, windowDays = DATE_WINDOW_DAYS) {
	if (!Number.isFinite(originMs)) return true
	if (!Number.isFinite(candidateMs)) return false
	return Math.abs(candidateMs - originMs) <= windowDays * DAY_MS
}

function isRecentStoryDateMs(ms, windowDays = FALLBACK_DATE_WINDOW_DAYS) {
	if (!Number.isFinite(ms)) return false
	return Math.abs(ms - Date.now()) <= windowDays * DAY_MS
}

function formatGoogleDate(ms) {
	let d = new Date(ms)
	return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`
}

function buildDateWindowFromStory(story) {
	let originMs = parseDateValue(story?.date)
	if (!isRecentStoryDateMs(originMs)) originMs = NaN
	if (!Number.isFinite(originMs)) originMs = parseDateFromUrl(story?.usedUrl || story?.url)
	if (!isRecentStoryDateMs(originMs)) originMs = NaN
	if (Number.isFinite(originMs)) {
		return {
			originMs,
			windowDays: DATE_WINDOW_DAYS,
			fallbackUnknownDateToNow: false,
			keepUnknownAfterSerp: true,
			originFallbackToToday: false,
		}
	}
	return {
		originMs: Date.now(),
		windowDays: FALLBACK_DATE_WINDOW_DAYS,
		fallbackUnknownDateToNow: true,
		keepUnknownAfterSerp: false,
		originFallbackToToday: true,
	}
}

function filterArticlesByDateWindow(articles, { originMs, windowDays, fallbackUnknownDateToNow }) {
	let unknownDate = 0
	let outOfWindow = 0
	let fallbackToToday = 0
	let nowMs = Date.now()

	let kept = []
	for (let article of articles || []) {
		let ms = candidateDateMs(article)
		if (!Number.isFinite(ms)) {
			unknownDate++
			if (!fallbackUnknownDateToNow) continue
			fallbackToToday++
			ms = nowMs
		}
		if (!isWithinDateWindow(ms, originMs, windowDays)) {
			outOfWindow++
			continue
		}
		kept.push(article)
	}

	return { kept, unknownDate, outOfWindow, fallbackToToday }
}

function tokenList(value) {
	return String(value || '')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/gu)
		.map(v => v.trim())
		.filter(v => Array.from(v).length >= 4)
		.filter(v => !STOPWORDS.has(v))
		.filter(v => !NOISY_KEYWORD_TOKENS.has(v))
		.filter(v => !/^\d+$/.test(v))
		// Drop long hash-like IDs from URLs (e.g. AP/Bloomberg slugs) to avoid noisy queries.
		.filter(v => !/^[a-f0-9]{10,}$/i.test(v))
		.filter(v => {
			let digits = (v.match(/\d/g) || []).length
			return digits <= Math.floor(v.length / 2)
		})
}

function hostTokens(url) {
	let host = hostFromUrl(url)
	if (!host) return new Set()
	return new Set(
		host
			.split('.')
			.map(v => v.trim().toLowerCase())
			.filter(v => v && v.length >= 3)
	)
}

function storyOriginalTitle(story) {
	return normalizeQueryText(story?.articleTitle || story?.titleEn || '')
}

function buildStoryKeywords({ articleTitle, titleEn, titleRu, url, text }) {
	let titleTokens = [
		...tokenList(storyOriginalTitle({ articleTitle, titleEn })),
	]
	let pathTokens = []
	try {
		let path = new URL(String(url || '')).pathname
		pathTokens = tokenList(path)
	} catch {}

	let lead = String(text || '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 500)
	let leadTokens = lead ? tokenList(lead) : []

	// Query seeds should prioritize headline/URL entities over body boilerplate.
	let base = uniq([...titleTokens, ...pathTokens])
	let leadCap = base.length >= 4 ? 6 : 12
	let list = uniq([...base, ...leadTokens.slice(0, leadCap)])
	if (!list.length) list = tokenList(titleRu)

	let banned = hostTokens(url)
	if (banned.size) list = list.filter(v => !banned.has(v))

	return uniq(list).slice(0, 24)
}

function storyUrlSearchTokens(story) {
	try {
		let path = new URL(String(story?.usedUrl || story?.url || '')).pathname
		return uniq(tokenList(path)).slice(0, 12)
	} catch {
		return []
	}
}

function storyPrimarySearchSignals(story) {
	let title = storyOriginalTitle(story)
	let titleTokens = uniq(tokenList(title)).slice(0, 12)
	let urlTokens = storyUrlSearchTokens(story)
	return {
		title,
		titleTokens,
		urlTokens,
	}
}

function storyYearTokens(story) {
	let ms = parseDateValue(story?.date)
	if (!Number.isFinite(ms)) ms = parseDateFromUrl(story?.usedUrl || story?.url)
	if (!Number.isFinite(ms)) return []
	let d = new Date(ms)
	let year = String(d.getUTCFullYear())
	let month = String(d.getUTCMonth() + 1).padStart(2, '0')
	return [year, `${year}-${month}`]
}

function normalizeQueryText(value) {
	return String(value || '')
		.replace(/[|/\\]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function buildYoutubeSearchQueries(story, storyKeywords, { openFallback = false } = {}) {
	let primary = storyPrimarySearchSignals(story)
	let title = primary.title
	if (title.length > 140) title = title.slice(0, 140).trim()
	let urlSeed = normalizeQueryText(primary.urlTokens.slice(0, 4).join(' '))

	let must = (storyKeywords || []).slice(0, 4)
	let context = (storyKeywords || []).slice(4, 12)
	let years = storyYearTokens(story).slice(0, 1)

	let queries = []
	if (title) {
		queries.push(title)
		if (urlSeed) queries.push(normalizeQueryText([title, ...primary.urlTokens.slice(0, 2), ...years].join(' ')))
	} else if (urlSeed) {
		queries.push(normalizeQueryText([...primary.urlTokens.slice(0, 4), ...years].join(' ')))
	} else if (must.length) {
		queries.push(normalizeQueryText([...must.slice(0, 4), ...years].join(' ')))
	}
	if (must.length >= 2) queries.push(normalizeQueryText([...must.slice(0, 3), ...years].join(' ')))
	if (must.length) queries.push(normalizeQueryText([...must.slice(0, 2), ...context.slice(0, 2), ...years].join(' ')))
	if (openFallback && context.length) {
		queries.push(normalizeQueryText([...must.slice(0, 1), ...context.slice(0, 4), ...years].join(' ')))
	}

	return uniq(queries.filter(Boolean)).slice(0, YOUTUBE_SEARCH_QUERIES)
}

function videoWebSearchOptions() {
	let searchContextSize = readEnv('OPENAI_WEBSEARCH_CONTEXT_SIZE')
	let opts = {}
	if (searchContextSize) opts.search_context_size = searchContextSize
	return opts
}

function extractJsonObjectFromText(value) {
	let text = String(value || '').trim()
	if (!text) return null

	let candidate = text
	let fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	if (fence?.[1]) candidate = fence[1].trim()
	let objectMatch = candidate.match(/\{[\s\S]*\}/)
	if (objectMatch) candidate = objectMatch[0]

	try {
		return JSON.parse(candidate)
	} catch {
		return null
	}
}

function parseGptVideoWebSearchOutput(rawText) {
	let parsed = extractJsonObjectFromText(rawText)
	let out = []
	if (parsed && typeof parsed === 'object' && Array.isArray(parsed.videos)) {
		for (let row of parsed.videos) {
			let url = normalizeYoutubeUrl(row?.url)
			if (!url) continue
			out.push({
				url,
				source: String(row?.source || '').trim(),
				title: String(row?.title || '').trim(),
				publishedAt: String(row?.publishedAt || '').trim(),
			})
		}
	}

	if (!out.length) {
		let urls = extractYoutubeUrlsFromHtml(rawText)
		for (let url of urls) {
			out.push({ url, source: '', title: '', publishedAt: '' })
		}
	}

	return uniqByUrl(out)
}

function countKeywordHits(haystack, keywords) {
	let h = String(haystack || '').toLowerCase()
	let hits = 0
	for (let k of keywords || []) {
		if (!k) continue
		if (h.includes(k)) hits++
	}
	return hits
}

function buildStoryMatchSignals(haystack, story, storyKeywords) {
	let primary = storyPrimarySearchSignals(story)
	let normalizedHaystack = String(haystack || '').toLowerCase()
	let titlePhrase = String(primary.title || '').toLowerCase()
	let titlePhraseHit = titlePhrase && normalizedHaystack.includes(titlePhrase) ? 1 : 0
	let titleHits = countKeywordHits(normalizedHaystack, primary.titleTokens)
	let urlHits = countKeywordHits(normalizedHaystack, primary.urlTokens)
	let keywordHits = countKeywordHits(normalizedHaystack, storyKeywords)
	let primaryHits = titlePhraseHit + titleHits + urlHits
	let matchScore = titlePhraseHit * 100 + titleHits * 20 + urlHits * 12 + keywordHits
	return {
		titlePhraseHit,
		titleHits,
		urlHits,
		primaryHits,
		keywordHits,
		matchScore,
	}
}

function compareCandidatesByStorySignals(a, b) {
	let scoreDelta = (b.matchScore || 0) - (a.matchScore || 0)
	if (scoreDelta) return scoreDelta
	let primaryDelta = (b.primaryHits || 0) - (a.primaryHits || 0)
	if (primaryDelta) return primaryDelta
	let keywordDelta = (b.keywordHits || 0) - (a.keywordHits || 0)
	if (keywordDelta) return keywordDelta
	let aMs = parseDateValue(a.publishedAt)
	let bMs = parseDateValue(b.publishedAt)
	if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs
	return 0
}

function preferPrimaryStorySignals(candidates, { sourceName = '', logger = null, logPrefix = 'VIDEOS' } = {}) {
	let list = Array.isArray(candidates) ? candidates : []
	if (!list.length) return []
	let primary = list.filter(v => (v.primaryHits || 0) > 0)
	if (primary.length) {
		return primary.sort(compareCandidatesByStorySignals)
	}
	let keywordFallback = list.filter(v => (v.keywordHits || 0) >= MIN_KEYWORD_HITS)
	if (!keywordFallback.length) {
		if (logger) logger(`${logPrefix} source skipped: no title/url hits`, `source=${sourceName || 'unknown'}`)
		return []
	}
	if (logger) {
		logger(
			`${logPrefix} keyword fallback:`,
			`source=${sourceName || 'unknown'}`,
			`kept=${keywordFallback.length}/${list.length}`,
		)
	}
	return keywordFallback.sort(compareCandidatesByStorySignals)
}

function limitVerifyPoolBySignal(withHits, { storyKeywords, remainingBudget, sourceName = '', logger = null } = {}) {
	let sorted = (withHits || [])
		.sort(compareCandidatesByStorySignals)

	if (!sorted.length) return []

	let topHits = Number(sorted[0]?.primaryHits || sorted[0]?.keywordHits || 0)
	let cap = YOUTUBE_VERIFY_VIDEOS_PER_SOURCE

	// Low-signal matches (single generic token) are expensive and usually noisy.
	if (topHits <= 1 && (storyKeywords || []).length >= 4) cap = Math.min(cap, 2)
	else if (topHits <= 2 && (storyKeywords || []).length >= 6) cap = Math.min(cap, 3)

	if (Number.isFinite(remainingBudget)) {
		cap = Math.min(cap, Math.max(0, remainingBudget))
	}
	if (cap <= 0) return []

	let limited = sorted.slice(0, cap)
	if (logger && limited.length < sorted.length) {
		logger(
			'VIDEOS verify pool capped:',
			`source=${sourceName || 'unknown'}`,
			`kept=${limited.length}/${sorted.length}`,
			`top_hits=${topHits}`,
		)
	}
	return limited
}

function normalizeYoutubeUrl(value) {
	let cleaned = String(value || '')
		.replace(/\\u002F/gi, '/')
		.replace(/\\\//g, '/')
		.replace(/&amp;/g, '&')
		.replace(/[),.;!?]+$/g, '')
		.trim()
	if (!cleaned) return ''

	let u
	try {
		u = new URL(cleaned)
	} catch {
		return ''
	}

	let host = u.hostname.toLowerCase().replace(/^www\./, '')
	if (host !== 'youtube.com'
		&& !host.endsWith('.youtube.com')
		&& host !== 'youtu.be'
		&& host !== 'youtube-nocookie.com'
		&& !host.endsWith('.youtube-nocookie.com')
	) return ''

	if (host === 'youtu.be') {
		let videoId = String(u.pathname || '').replace(/^\/+/, '').split('/')[0]
		return videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''
	}

	if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
		let watchVideoId = u.searchParams.get('v')
		if (u.pathname === '/watch' && watchVideoId) {
			return `https://www.youtube.com/watch?v=${watchVideoId}`
		}

		let embed = u.pathname.match(/^\/embed\/([^/?#]+)/)
		if (embed?.[1]) return `https://www.youtube.com/watch?v=${embed[1]}`

		let shorts = u.pathname.match(/^\/shorts\/([^/?#]+)/)
		if (shorts?.[1]) return `https://www.youtube.com/watch?v=${shorts[1]}`

		let live = u.pathname.match(/^\/live\/([^/?#]+)/)
		if (live?.[1]) return `https://www.youtube.com/watch?v=${live[1]}`

		// Reject channel/profile/playlist pages, we need a concrete video URL.
		return ''
	}

	return ''
}

function extractYoutubeUrlsFromHtml(html) {
	let text = String(html || '')
	if (!text) return []

	let normalized = text
		.replace(/\\u002F/gi, '/')
		.replace(/\\\//g, '/')
		.replace(/&amp;/g, '&')
	let matches = normalized.match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/[^\s"'<>\\)]+/gi) || []
	return uniq(matches.map(normalizeYoutubeUrl).filter(Boolean))
}

function youtubeVideoId(videoUrl) {
	let normalized = normalizeYoutubeUrl(videoUrl)
	if (!normalized) return ''
	try {
		let u = new URL(normalized)
		let host = u.hostname.toLowerCase().replace(/^www\./, '')
		if (host === 'youtu.be') return String(u.pathname || '').replace(/^\/+/, '').split('/')[0]
		if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
			let v = u.searchParams.get('v')
			if (v) return v
			let embed = u.pathname.match(/^\/embed\/([^/?#]+)/)
			if (embed?.[1]) return embed[1]
		}
	} catch {}
	return ''
}

function decodeHtmlBasic(text) {
	return String(text || '')
		.replace(/&quot;/gi, '"')
		.replace(/&#34;/gi, '"')
		.replace(/&apos;|&#39;/gi, "'")
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#x2F;/gi, '/')
}

function parseMetaTagContent(html, name) {
	let rx = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i')
	let m = String(html || '').match(rx)
	return decodeHtmlBasic(m?.[1] || '').trim()
}

function parseYoutubeShortDescription(html) {
	let text = String(html || '')
	if (!text) return ''

	let m = text.match(/"shortDescription":"((?:\\.|[^"\\])*)"/)
	if (!m?.[1]) return ''
	try {
		let decoded = JSON.parse(`"${m[1]}"`)
		return String(decoded || '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, VERIFY_VIDEO_DESCRIPTION_MAX_CHARS)
	} catch {
		return ''
	}
}

function decodeJsonStringValue(value) {
	let raw = String(value || '')
	if (!raw) return ''
	try {
		return String(JSON.parse(`"${raw}"`) || '')
	} catch {
		return raw
	}
}

function parseYoutubePlayabilityStatus(html) {
	let text = String(html || '')
	if (!text) return { status: '', reason: '' }
	let status = String(
		text.match(/"playabilityStatus"\s*:\s*\{[\s\S]*?"status"\s*:\s*"([^"]+)"/i)?.[1]
		|| ''
	).trim()
	let reason = decodeJsonStringValue(
		text.match(/"playabilityStatus"\s*:\s*\{[\s\S]*?"reason"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1]
		|| text.match(/"playabilityStatus"\s*:\s*\{[\s\S]*?"simpleText"\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1]
		|| ''
	).trim()
	return { status, reason }
}

function inferYoutubeAvailabilityFromWatchHtml(html) {
	let text = String(html || '')
	if (!text) return { available: null, reason: '' }

	let playability = parseYoutubePlayabilityStatus(text)
	if (playability.status) {
		if (playability.status === 'OK') return { available: true, reason: '' }
		return {
			available: false,
			reason: playability.reason || `playability_${playability.status.toLowerCase()}`,
		}
	}

	let title = parseMetaTagContent(text, 'og:title') || parseMetaTagContent(text, 'title')
	let unavailableHint = `${title}\n${htmlToSnippet(text, 400)}`
	if (/\bvideo unavailable\b/i.test(unavailableHint)) {
		return { available: false, reason: title || 'video_unavailable' }
	}
	if (/\bthis video is private\b/i.test(unavailableHint)) {
		return { available: false, reason: title || 'video_private' }
	}
	if (/\bthis video has been removed\b/i.test(unavailableHint)) {
		return { available: false, reason: title || 'video_removed' }
	}
	if (title) return { available: true, reason: '' }
	return { available: null, reason: '' }
}

function logUnavailableYoutubeVideo({ source = '', videoUrl = '', reason = '', logger = console.log }) {
	logger(
		'VIDEOS unavailable:',
		`source=${source || 'unknown'}`,
		`reason=${reason || 'unavailable'}`,
		`video=${videoUrl || 'n/a'}`,
	)
}

async function fetchYoutubeMetadata(videoUrl, logger = console.log) {
	let normalized = normalizeYoutubeUrl(videoUrl)
	if (!normalized) return { title: '', author: '', description: '', available: null, availabilityReason: '' }
	if (youtubeMetadataCache.has(normalized)) {
		return await youtubeMetadataCache.get(normalized)
	}

	let promise = (async () => {
		let videoId = youtubeVideoId(normalized)
		let meta = {
			title: '',
			author: '',
			description: '',
			available: null,
			availabilityReason: '',
		}
		let oembedOk = false
		let oembedStatus = 0

		try {
			let endpoint = new URL('https://www.youtube.com/oembed')
			endpoint.searchParams.set('url', normalized)
			endpoint.searchParams.set('format', 'json')
			let res = await fetch(endpoint, { signal: AbortSignal.timeout(YOUTUBE_OEMBED_TIMEOUT_MS) })
			oembedStatus = Number(res?.status || 0)
			if (res.ok) {
				let json = await res.json().catch(() => ({}))
				meta.title = String(json?.title || '').trim()
				meta.author = String(json?.author_name || '').trim()
				meta.available = true
				oembedOk = true
			}
		} catch (e) {
			logger('VIDEOS_YOUTUBE_META failed', String(e?.message || e))
		}

		if (!videoId) {
			if (meta.available == null && oembedStatus && oembedStatus < 500 && oembedStatus !== 429) {
				meta.available = false
				meta.availabilityReason = `oembed_${oembedStatus}`
			}
			return meta
		}

		try {
			let watchUrl = new URL('https://www.youtube.com/watch')
			watchUrl.searchParams.set('v', videoId)
			watchUrl.searchParams.set('hl', 'en')
			let res = await fetch(watchUrl, { signal: AbortSignal.timeout(YOUTUBE_WATCH_TIMEOUT_MS) })
			let watchStatus = Number(res?.status || 0)
			if (!res.ok) {
				if (meta.available == null && watchStatus && watchStatus < 500 && watchStatus !== 429) {
					meta.available = false
					meta.availabilityReason = `watch_${watchStatus}`
				}
				return meta
			}

			let html = await res.text().catch(() => '')
			if (!html) return meta

			let availability = inferYoutubeAvailabilityFromWatchHtml(html)
			if (availability.available != null) meta.available = availability.available
			if (availability.reason) meta.availabilityReason = availability.reason

			if (!meta.title) meta.title = parseMetaTagContent(html, 'og:title') || parseMetaTagContent(html, 'title')
			if (!meta.description) {
				meta.description = parseMetaTagContent(html, 'og:description')
					|| parseMetaTagContent(html, 'description')
					|| parseYoutubeShortDescription(html)
			}
		} catch (e) {
			logger('VIDEOS_YOUTUBE_META watch fetch failed', String(e?.message || e))
		}

		if (meta.available == null) {
			if (oembedOk || meta.title || meta.author) {
				meta.available = true
			} else if (oembedStatus && oembedStatus < 500 && oembedStatus !== 429) {
				meta.available = false
				meta.availabilityReason = `oembed_${oembedStatus}`
			}
		}

		meta.description = String(meta.description || '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, VERIFY_VIDEO_DESCRIPTION_MAX_CHARS)
		return meta
	})()

	youtubeMetadataCache.set(normalized, promise)
	return await promise
}

async function enrichYoutubeVideoCandidate(video, { source = '', channelTitle = '', logger = console.log } = {}) {
	let normalizedUrl = normalizeYoutubeUrl(video?.url)
	if (!normalizedUrl) return null

	let meta = await fetchYoutubeMetadata(normalizedUrl, logger)
	if (meta.available === false) {
		logUnavailableYoutubeVideo({
			source,
			videoUrl: normalizedUrl,
			reason: meta.availabilityReason,
			logger,
		})
		return null
	}

	let enriched = {
		url: normalizedUrl,
		source: String(video?.source || source || '').trim(),
		title: String(meta.title || video?.title || '').trim(),
		author: String(meta.author || video?.author || channelTitle || source || '').trim(),
		description: String(meta.description || video?.description || '').trim(),
		publishedAt: String(video?.publishedAt || '').trim(),
	}

	let excluded = isExcludedVideoByChannel({
		source,
		channelTitle,
		author: enriched.author,
	})
	if (excluded) {
		logger(
			'VIDEOS excluded channel:',
			`source=${source || 'unknown'}`,
			`author=${enriched.author || 'unknown'}`,
			`video=${normalizedUrl}`,
		)
		return null
	}

	return enriched
}

function htmlToSnippet(html, maxChars = VERIFY_SNIPPET_MAX_CHARS) {
	let text = String(html || '')
	if (!text) return ''
	text = text
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim()
	return text.slice(0, maxChars)
}

async function fetchCandidatePage(url) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			let response = await fetch(url, { signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS) })
			let status = Number(response?.status || 0)
			let statusText = String(response?.statusText || '')
			if (response.ok) {
				let html = await response.text().catch(() => '')
				if (html) return { ok: true, html, status, statusText }
				return { ok: false, status, statusText, error: 'empty_body' }
			}
			return { ok: false, status, statusText, error: `HTTP ${status} ${statusText}`.trim() }
		} catch (e) {
			if (attempt >= 1) {
				return { ok: false, status: 0, statusText: '', error: String(e?.message || e || 'fetch_error') }
			}
		}
	}
	return { ok: false, status: 0, statusText: '', error: 'fetch_error' }
}

function isTransientApiError(e) {
	let status = Number(e?.status || e?.statusCode || e?.response?.status)
	if (status === 429) return true
	if (status >= 500 && status <= 599) return true

	let code = String(e?.code || e?.error?.code || '').toUpperCase()
	if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EAI_AGAIN') return true

	let message = `${e?.message || ''} ${e?.error?.message || ''}`.toLowerCase()
	return message.includes('timeout')
}

function isTimeoutLikeError(e) {
	let name = String(e?.name || '').toLowerCase()
	if (name === 'aborterror' || name.includes('timeout')) return true
	let message = String(e?.message || '').toLowerCase()
	return message.includes('timeout') || message.includes('aborted')
}

function isTransientHttpStatus(status) {
	let n = Number(status)
	if (!Number.isFinite(n)) return false
	return n === 429 || (n >= 500 && n <= 599)
}

function normalizeVerifyDecision(parsed) {
	let confidence = Number(parsed?.confidence)
	if (!Number.isFinite(confidence)) confidence = 0
	if (confidence < 0) confidence = 0
	if (confidence > 1) confidence = 1
	return {
		match: Boolean(parsed?.match) && confidence >= VERIFY_MIN_CONFIDENCE,
		confidence,
		reason: String(parsed?.reason || '').trim(),
	}
}

function parseBatchVerifyDecisions(parsed, validUrls) {
	let decisions = new Map()
	for (let row of parsed?.decisions || []) {
		let url = normalizeYoutubeUrl(row?.videoUrl)
		if (!url) continue
		if (validUrls && !validUrls.has(url)) continue
		decisions.set(url, normalizeVerifyDecision(row))
	}
	return decisions
}

async function verifyVideoCandidatesRelevance({ story, candidate, candidateSnippet, videos, logger }) {
	let normalizedVideos = (videos || [])
		.map(v => ({
			...v,
			url: normalizeYoutubeUrl(v?.url),
		}))
		.filter(v => v.url)
	if (!normalizedVideos.length) return new Map()

	if (!videoVerifyEnabled || !openai) {
		let out = new Map()
		for (let v of normalizedVideos) {
			out.set(v.url, { match: true, confidence: 1, reason: 'verify_disabled' })
		}
		return out
	}

	let validUrls = new Set(normalizedVideos.map(v => v.url))
	let originalSnippet = String(story?.text || '').replace(/\s+/g, ' ').trim().slice(0, VERIFY_SNIPPET_MAX_CHARS)
	let payload = {
		original: {
			titleEn: String(story?.titleEn || '').trim(),
			titleRu: String(story?.titleRu || '').trim(),
			url: String(story?.usedUrl || story?.url || '').trim(),
			date: String(story?.date || '').trim(),
			snippet: originalSnippet,
		},
		candidate: {
			title: String(candidate?.title || '').trim(),
			source: String(candidate?.source || resolveTrustedSourceByUrl(candidate?.url) || '').trim(),
			url: String(candidate?.url || '').trim(),
			publishedAt: String(candidate?.publishedAt || '').trim(),
			snippet: String(candidateSnippet || '').slice(0, VERIFY_SNIPPET_MAX_CHARS),
			videos: normalizedVideos.map(v => ({
				videoUrl: String(v.url || '').trim(),
				videoTitle: String(v.title || '').trim(),
				videoAuthor: String(v.author || '').trim(),
				videoDescription: String(v.description || '').trim(),
			})),
		},
	}

	try {
		let built = buildChatCompletionsRequest({
			model: videoVerifyModel,
			temperature: VERIFY_TEMPERATURE,
			reasoningEffort: VERIFY_REASONING_EFFORT,
			responseFormat: VIDEO_VERIFY_RESPONSE_FORMAT,
			messages: [
				{
					role: 'system',
					content: [
						'You verify whether each linked YouTube video can be used as B-roll/context for the original story.',
						'Mark match=true when the video is either (A) the same event OR (B) close contextual coverage of the same topic/entities.',
						'For case (B), keep confidence moderate (around 0.55-0.75).',
						'Set match=false only when clearly unrelated.',
						'Return one decision per videoUrl.',
						'Return JSON only.',
					].join(' '),
				},
				{
					role: 'user',
					content: JSON.stringify(payload),
				},
			],
		})

		let res = await openai.chat.completions.create(built.request)

		estimateAndLogCost({
			task: 'video_verify_batch',
			model: videoVerifyModel,
			usage: res?.usage,
			logger,
		})

		let content = res?.choices?.[0]?.message?.content
		if (!content) {
			let out = new Map()
			for (let v of normalizedVideos) out.set(v.url, { match: false, confidence: 0, reason: 'verify_empty' })
			return out
		}

		let parsed
		try {
			parsed = JSON.parse(content)
		} catch {
			let out = new Map()
			for (let v of normalizedVideos) out.set(v.url, { match: false, confidence: 0, reason: 'verify_json_parse_failed' })
			return out
		}

		let out = parseBatchVerifyDecisions(parsed, validUrls)
		for (let v of normalizedVideos) {
			if (out.has(v.url)) continue
			out.set(v.url, { match: false, confidence: 0, reason: 'verify_missing' })
		}
		return out
	} catch (e) {
		logger('VIDEOS_VERIFY failed\n', e)
		let out = new Map()
		for (let v of normalizedVideos) out.set(v.url, { match: false, confidence: 0, reason: 'verify_error' })
		return out
	}
}

function toCandidate(raw, sourceHint = '') {
	let url = normalizeHttpUrl(raw?.url || raw)
	if (!url) return
	let source = String(raw?.source || sourceHint || '').trim()
	let title = String(raw?.title || '').trim()
	let publishedAt = raw?.publishedAt || raw?.dateTime || raw?.date || ''
	return { url, source, title, publishedAt }
}

function filterTrustedCandidates(candidates, {
	originMs,
	storyKeywords,
	logger,
	stage,
	keepUnknownDates = false,
	windowDays = DATE_WINDOW_DAYS,
	fallbackUnknownDateToNow = false,
}) {
	let trusted = uniqByUrl((candidates || []).filter(v => isTrustedSourcePage(v.url)))

	if (Number.isFinite(originMs)) {
		let unknownDate = 0
		let outOfWindow = 0
		let fallbackToToday = 0
		let nowMs = Date.now()
		trusted = trusted.filter(v => {
			let ms = candidateDateMs(v)
			if (!Number.isFinite(ms)) {
				unknownDate++
				if (fallbackUnknownDateToNow) {
					fallbackToToday++
					ms = nowMs
				} else {
					return keepUnknownDates
				}
			}
			let inWindow = isWithinDateWindow(ms, originMs, windowDays)
			if (!inWindow) outOfWindow++
			return inWindow
		})
		logger(
			`VIDEOS ${stage} date-filtered candidates:`,
			trusted.length,
			`unknown_date=${unknownDate}`,
			`fallback_today=${fallbackToToday}`,
			`out_of_window=${outOfWindow}`,
			`keep_unknown=${keepUnknownDates ? 'yes' : 'no'}`,
			`window=+/-${windowDays}d`,
		)
	}

	if (storyKeywords.length >= 2) {
		let filtered = trusted.filter(v => {
			let haystack = `${v.title || ''}\n${v.source || ''}\n${v.url || ''}`
			return countKeywordHits(haystack, storyKeywords) >= MIN_KEYWORD_HITS
		})
		if (filtered.length) trusted = filtered
		else logger(`VIDEOS ${stage} keyword filter skipped (too strict)`)
	}

	return uniqByUrl(trusted)
}

async function searchTrustedPagesViaSerpApi(story, { originMs, storyKeywords, logger, windowDays = DATE_WINDOW_DAYS }) {
	let apiKey = readEnv('SERPAPI_KEY')
	if (!apiKey) {
		logger('VIDEOS_SERPAPI skipped: SERPAPI_KEY missing')
		return []
	}
	if (serpapiDisabledForRun) {
		if (!serpapiDisabledLogged) {
			serpapiDisabledLogged = true
			logger('VIDEOS_SERPAPI skipped: disabled for current run', `reason=${serpapiDisabledReason || 'n/a'}`)
		}
		return []
	}
	if (Date.now() < serpapiCooldownUntilMs) {
		let waitMs = serpapiCooldownUntilMs - Date.now()
		logger('VIDEOS_SERPAPI skipped: cooldown active', `wait_ms=${waitMs}`)
		return []
	}

	let title = String(story?.titleEn || story?.titleRu || '').trim()
	let domainQuery = TRUSTED_DOMAIN_LIST.map(d => `site:${d}`).join(' OR ')
	let queries = uniq([
		title ? `"${title}" (${domainQuery})` : '',
		storyKeywords.length ? `${storyKeywords.slice(0, 5).join(' ')} (${domainQuery})` : '',
	].filter(Boolean)).slice(0, 2)
	if (!queries.length) return []

	let out = []
	for (let query of queries) {
		let retriedTransient = false
		for (;;) {
			try {
				let u = new URL('https://serpapi.com/search.json')
				u.searchParams.set('engine', 'google')
				u.searchParams.set('q', query)
				u.searchParams.set('num', '10')
				u.searchParams.set('hl', 'en')
				u.searchParams.set('gl', 'us')
				if (Number.isFinite(originMs)) {
					let minDate = formatGoogleDate(originMs - windowDays * DAY_MS)
					let maxDate = formatGoogleDate(originMs + windowDays * DAY_MS)
					u.searchParams.set('tbs', `cdr:1,cd_min:${minDate},cd_max:${maxDate}`)
				}
				u.searchParams.set('api_key', apiKey)

				trackApiRequest('serpapi')
				let response = await fetch(u, { signal: AbortSignal.timeout(SERPAPI_TIMEOUT_MS) })
				if (!response.ok) {
					trackApiResult('serpapi', 'failed')
					let status = Number(response.status || 0)
					if (status === 429) {
						serpapiDisabledForRun = true
						serpapiDisabledReason = '429'
						serpapiCooldownUntilMs = Math.max(serpapiCooldownUntilMs, Date.now() + SERPAPI_COOLDOWN_MS)
						logger(
							'VIDEOS_SERPAPI failed',
							status,
							response.statusText,
							`cooldown_ms=${SERPAPI_COOLDOWN_MS}`,
							'disabled_for_run=yes',
						)
					} else {
						logger('VIDEOS_SERPAPI failed', status, response.statusText)
					}
					if (status === 429) break
					if (isTransientHttpStatus(status) && !retriedTransient) {
						retriedTransient = true
						logger('VIDEOS_SERPAPI transient error, retrying once', `status=${status}`)
						await sleep(SERPAPI_RETRY_DELAY_MS, 'videos_serpapi_transient_retry')
						continue
					}
					break
				}
				trackApiResult('serpapi', 'success')

				let json = await response.json().catch(() => ({}))
				let added = 0
				for (let item of json?.organic_results || []) {
					let url = normalizeHttpUrl(item?.link)
					if (!url || !isTrustedSourcePage(url)) continue
					out.push({
						url,
						title: String(item?.title || '').trim(),
						source: resolveTrustedSourceByUrl(url),
						publishedAt: item?.date || item?.published || item?.dateTime || '',
					})
					added++
				}
				for (let item of json?.news_results || []) {
					let url = normalizeHttpUrl(item?.link)
					if (!url || !isTrustedSourcePage(url)) continue
					out.push({
						url,
						title: String(item?.title || '').trim(),
						source: resolveTrustedSourceByUrl(url),
						publishedAt: item?.date || item?.published || item?.dateTime || '',
					})
					added++
				}
				if (added) logger('VIDEOS_SERPAPI added', added, 'urls for query:', query)
				break
			} catch (e) {
				trackApiResult('serpapi', isTimeoutLikeError(e) ? 'timeout' : 'failed')
				if (isTimeoutLikeError(e) && !retriedTransient) {
					retriedTransient = true
					logger('VIDEOS_SERPAPI timeout, retrying once')
					await sleep(SERPAPI_RETRY_DELAY_MS, 'videos_serpapi_timeout_retry')
					continue
				}
				logger('VIDEOS_SERPAPI error\n', e)
				break
			}
		}
		if (Date.now() < serpapiCooldownUntilMs) break
		if (out.length >= MAX_CANDIDATE_PAGES) break
	}

	return uniqByUrl(out).slice(0, MAX_CANDIDATE_PAGES)
}

function isYoutubeQuotaExceeded(payload) {
	let errors = Array.isArray(payload?.error?.errors) ? payload.error.errors : []
	let reasons = errors.map(e => String(e?.reason || '').trim().toLowerCase()).filter(Boolean)
	return reasons.includes('quotaexceeded')
		|| reasons.includes('dailylimitexceeded')
		|| reasons.includes('dailylimitexceededunreg')
		|| reasons.includes('userratelimitexceeded')
}

function parseYoutubeAuthErrorReason(error) {
	let raw = String(error || '').toLowerCase()
	if (raw.includes('invalid_grant')) return 'invalid_grant'
	if (raw.includes('unauthorized_client')) return 'unauthorized_client'
	if (raw.includes('invalid_client')) return 'invalid_client'
	if (raw.includes('access_denied')) return 'access_denied'
	let msg = String(error?.message || '').toLowerCase()
	if (msg.includes('invalid_grant')) return 'invalid_grant'
	if (msg.includes('unauthorized_client')) return 'unauthorized_client'
	if (msg.includes('invalid_client')) return 'invalid_client'
	if (msg.includes('access_denied')) return 'access_denied'
	let code = String(error?.code || error?.error || '').toLowerCase()
	if (code.includes('invalid_grant')) return 'invalid_grant'
	if (code.includes('unauthorized_client')) return 'unauthorized_client'
	if (code.includes('invalid_client')) return 'invalid_client'
	if (code.includes('access_denied')) return 'access_denied'
	let reason = String(error?.response?.data?.error || '').toLowerCase()
	if (reason.includes('invalid_grant')) return 'invalid_grant'
	if (reason.includes('unauthorized_client')) return 'unauthorized_client'
	if (reason.includes('invalid_client')) return 'invalid_client'
	if (reason.includes('access_denied')) return 'access_denied'
	let desc = String(error?.response?.data?.error_description || '').toLowerCase()
	if (desc.includes('invalid_grant')) return 'invalid_grant'
	if (desc.includes('unauthorized_client')) return 'unauthorized_client'
	if (desc.includes('invalid_client')) return 'invalid_client'
	if (desc.includes('access_denied')) return 'access_denied'
	return ''
}

function parseYoutubeApiAuthFailure(status, payload) {
	let code = Number(status || 0)
	if (code !== 401 && code !== 403) return ''

	let reasons = Array.isArray(payload?.error?.errors)
		? payload.error.errors.map(v => String(v?.reason || '').toLowerCase()).filter(Boolean)
		: []
	if (reasons.includes('authexception') || reasons.includes('autherror') || reasons.includes('forbidden')) {
		return 'auth_error'
	}

	let msg = String(payload?.error?.message || '').toLowerCase()
	if (msg.includes('unauthorized_client')) return 'unauthorized_client'
	if (msg.includes('invalid_grant')) return 'invalid_grant'
	if (msg.includes('invalid_client')) return 'invalid_client'
	if (msg.includes('access_denied')) return 'access_denied'
	if (msg.includes('unauthorized') || msg.includes('forbidden')) return 'auth_error'
	return ''
}

async function getYoutubeAuthHeaders({ logger }) {
	if (!youtubeOauthClient) return {}
	if (youtubeAuthBroken) return {}
	try {
		let headers = await youtubeOauthClient.getRequestHeaders('https://www.googleapis.com/youtube/v3/')
		let auth = String(headers?.Authorization || headers?.authorization || '').trim()
		if (!auth) return {}
		return { Authorization: auth }
	} catch (e) {
		let authReason = parseYoutubeAuthErrorReason(e)
		if (authReason) {
			youtubeAuthBroken = true
			youtubeAuthBrokenReason = authReason
			if (!youtubeAuthBrokenLogged) {
				youtubeAuthBrokenLogged = true
				logger(`VIDEOS_YTAPI auth disabled for current run: ${authReason}`)
			}
			return {}
		}
		logger('VIDEOS_YTAPI auth failed', String(e?.message || e))
		return {}
	}
}

async function youtubeApiGetJson(url, { logger }) {
	if (!youtubeOauthClient) {
		logger('VIDEOS_YTAPI skipped: missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN')
		return null
	}
	if (youtubeAuthBroken) return null

	let retriedTransient = false
	for (;;) {
		try {
			let headers = await getYoutubeAuthHeaders({ logger })
			if (!headers.Authorization) {
				return null
			}

			trackApiRequest('youtubeapi')
			let response = await fetch(url, {
				headers,
				signal: AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS),
			})
			let status = Number(response?.status || 0)
			let body = await response.json().catch(() => ({}))

			if (!response.ok || body?.error) {
				trackApiResult('youtubeapi', 'failed')
				let authFailure = parseYoutubeApiAuthFailure(status, body)
				if (authFailure) {
					youtubeAuthBroken = true
					youtubeAuthBrokenReason = authFailure
					if (!youtubeAuthBrokenLogged) {
						youtubeAuthBrokenLogged = true
						logger(`VIDEOS_YTAPI auth disabled for current run: ${authFailure}`)
					}
					return null
				}
				if (isYoutubeQuotaExceeded(body)) {
					logger('VIDEOS_YTAPI quota exceeded')
					return null
				}

				if (isTransientHttpStatus(status) && !retriedTransient) {
					retriedTransient = true
					logger('VIDEOS_YTAPI transient error, retrying once', `status=${status}`)
					await sleep(YOUTUBE_API_RETRY_DELAY_MS, 'videos_youtube_api_http_retry')
					continue
				}

				logger('VIDEOS_YTAPI failed', `status=${status}`, `error=${body?.error?.message || response?.statusText || 'n/a'}`)
				return null
			}

			trackApiResult('youtubeapi', 'success')
			return body
		} catch (e) {
			trackApiResult('youtubeapi', isTimeoutLikeError(e) ? 'timeout' : 'failed')
			if (isTransientApiError(e) && !retriedTransient) {
				retriedTransient = true
				logger('VIDEOS_YTAPI transient error, retrying once')
				await sleep(YOUTUBE_API_RETRY_DELAY_MS, 'videos_youtube_api_transient_retry')
				continue
			}
			logger('VIDEOS_YTAPI error', String(e?.message || e))
			return null
		}
	}
}

function youtubeChannelUrl(handle, fallbackChannelId = '') {
	let h = String(handle || '').trim().replace(/^@/, '')
	if (h) return `https://www.youtube.com/@${h}`
	let id = String(fallbackChannelId || '').trim()
	if (id) return `https://www.youtube.com/channel/${id}`
	return 'https://www.youtube.com'
}

function cleanupXmlValue(value) {
	let text = String(value || '')
	if (!text) return ''
	text = text
		.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1')
		.replace(/\s+/g, ' ')
		.trim()
	return decodeHtmlBasic(text)
}

function escapeRegex(text) {
	return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseXmlTag(xml, tagName) {
	let tag = escapeRegex(tagName)
	let rx = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
	let match = String(xml || '').match(rx)
	if (!match?.[1]) return ''
	return cleanupXmlValue(match[1])
}

function extractYoutubeChannelIdFromHtml(html) {
	let text = String(html || '')
	if (!text) return ''
	let patterns = [
		/itemprop=["']channelId["'][^>]*content=["'](UC[0-9A-Za-z_-]{20,})["']/i,
		/"channelId":"(UC[0-9A-Za-z_-]{20,})"/i,
		/"externalId":"(UC[0-9A-Za-z_-]{20,})"/i,
	]
	for (let rx of patterns) {
		let m = text.match(rx)
		if (m?.[1]) return String(m[1]).trim()
	}
	return ''
}

async function fetchYoutubeChannelPage(url, { logger }) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			let response = await fetch(url, {
				headers: {
					accept: 'text/html,application/xhtml+xml',
				},
				signal: AbortSignal.timeout(YOUTUBE_RSS_TIMEOUT_MS),
			})
			if (!response.ok) {
				if (attempt >= 1 || !isTransientHttpStatus(response.status)) return ''
				await sleep(YOUTUBE_RSS_RETRY_DELAY_MS, 'videos_youtube_channel_fetch_http_retry')
				continue
			}
			let html = await response.text().catch(() => '')
			if (html) return html
			if (attempt < 1) {
				await sleep(YOUTUBE_RSS_RETRY_DELAY_MS, 'videos_youtube_channel_fetch_empty_retry')
				continue
			}
			return ''
		} catch (e) {
			if (isTransientApiError(e) && attempt < 1) {
				await sleep(YOUTUBE_RSS_RETRY_DELAY_MS, 'videos_youtube_channel_fetch_transient_retry')
				continue
			}
			logger('VIDEOS_YTRSS channel fetch failed', String(e?.message || e))
			return ''
		}
	}
	return ''
}

async function resolveYoutubeRssSource(sourceName, { logger }) {
	let source = String(sourceName || '').trim()
	if (!source) return null
	if (youtubeRssSourceCache.has(source)) return youtubeRssSourceCache.get(source)

	let handles = YOUTUBE_SOURCE_HANDLES[source] || []
	if (!handles.length) {
		youtubeRssSourceCache.set(source, null)
		return null
	}

	for (let rawHandle of handles) {
		let handle = String(rawHandle || '').trim().replace(/^@/, '')
		if (!handle) continue

		let channelUrl = youtubeChannelUrl(handle)
		let html = await fetchYoutubeChannelPage(channelUrl, { logger })
		if (!html) {
			html = await fetchYoutubeChannelPage(`${channelUrl}/videos`, { logger })
		}
		if (!html) continue

		let channelId = extractYoutubeChannelIdFromHtml(html)
		if (!channelId) continue

		let resolved = {
			source,
			handle,
			channelId,
			channelTitle: source,
			channelUrl: youtubeChannelUrl(handle, channelId),
		}
		youtubeRssSourceCache.set(source, resolved)
		return resolved
	}

	youtubeRssSourceCache.set(source, null)
	logger('VIDEOS_YTRSS source unresolved:', source)
	return null
}

function parseYoutubeRssEntries(xml, source) {
	let blocks = String(xml || '').match(/<entry\b[\s\S]*?<\/entry>/gi) || []
	let out = []
	for (let block of blocks) {
		let videoId = parseXmlTag(block, 'yt:videoId')
		let url = normalizeYoutubeUrl(videoId ? `https://www.youtube.com/watch?v=${videoId}` : '')
		if (!url) continue

		let title = parseXmlTag(block, 'title')
		let publishedAt = parseXmlTag(block, 'published')
		let author = parseXmlTag(block, 'name')
		let description = parseXmlTag(block, 'media:description')
		description = String(description || '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, VERIFY_VIDEO_DESCRIPTION_MAX_CHARS)

		out.push({
			url,
			source: source?.source || '',
			title,
			description,
			author,
			publishedAt,
		})
	}
	return out
}

async function fetchYoutubeRssEntriesForSource(source, { logger }) {
	let key = String(source?.source || '').trim()
	if (!key) return []
	if (youtubeRssFeedCache.has(key)) return youtubeRssFeedCache.get(key) || []

	let channelId = String(source?.channelId || '').trim()
	if (!channelId) return []

	let xml = ''
	let retriedTransient = false
	for (;;) {
		try {
			let feedUrl = new URL('https://www.youtube.com/feeds/videos.xml')
			feedUrl.searchParams.set('channel_id', channelId)

			trackApiRequest('youtuberss')
			let response = await fetch(feedUrl, {
				headers: { accept: 'application/atom+xml,application/xml,text/xml' },
				signal: AbortSignal.timeout(YOUTUBE_RSS_TIMEOUT_MS),
			})
			if (!response.ok) {
				trackApiResult('youtuberss', 'failed')
				if (isTransientHttpStatus(response.status) && !retriedTransient) {
					retriedTransient = true
					await sleep(YOUTUBE_RSS_RETRY_DELAY_MS, 'videos_youtube_rss_http_retry')
					continue
				}
				logger('VIDEOS_YTRSS feed failed', `source=${key}`, `status=${response.status}`, response.statusText || '')
				youtubeRssFeedCache.set(key, [])
				return []
			}

			xml = await response.text().catch(() => '')
			if (!xml) {
				trackApiResult('youtuberss', 'failed')
				logger('VIDEOS_YTRSS feed empty', `source=${key}`)
				youtubeRssFeedCache.set(key, [])
				return []
			}

			trackApiResult('youtuberss', 'success')
			break
		} catch (e) {
			trackApiResult('youtuberss', isTimeoutLikeError(e) ? 'timeout' : 'failed')
			if (isTransientApiError(e) && !retriedTransient) {
				retriedTransient = true
				await sleep(YOUTUBE_RSS_RETRY_DELAY_MS, 'videos_youtube_rss_transient_retry')
				continue
			}
			logger('VIDEOS_YTRSS feed error', `source=${key}`, String(e?.message || e))
			youtubeRssFeedCache.set(key, [])
			return []
		}
	}

	let entries = parseYoutubeRssEntries(xml, source)
	logger('VIDEOS_YTRSS feed:', `source=${key}`, `raw=${entries.length}`)
	youtubeRssFeedCache.set(key, entries)
	return entries
}

async function resolveYoutubeSource(sourceName, { logger }) {
	let source = String(sourceName || '').trim()
	if (!source) return null
	if (!youtubeOauthClient) return null
	if (youtubeAuthBroken) return null
	if (youtubeSourceCache.has(source)) return youtubeSourceCache.get(source)

	let handles = YOUTUBE_SOURCE_HANDLES[source] || []
	if (!handles.length) {
		youtubeSourceCache.set(source, null)
		return null
	}

	for (let rawHandle of handles) {
		let handle = String(rawHandle || '').trim().replace(/^@/, '')
		if (!handle) continue

		let url = new URL('https://www.googleapis.com/youtube/v3/channels')
		url.searchParams.set('part', 'id,contentDetails,snippet')
		url.searchParams.set('forHandle', handle)

		let json = await youtubeApiGetJson(url, { logger })
		if (!json) continue

		let item = Array.isArray(json?.items) ? json.items[0] : null
		let channelId = String(item?.id || '').trim()
		let uploadsPlaylistId = String(item?.contentDetails?.relatedPlaylists?.uploads || '').trim()
		if (!channelId || !uploadsPlaylistId) continue

		let resolved = {
			source,
			handle,
			channelId,
			uploadsPlaylistId,
			channelTitle: String(item?.snippet?.title || '').trim(),
			channelUrl: youtubeChannelUrl(handle, channelId),
		}
		youtubeSourceCache.set(source, resolved)
		return resolved
	}

	logger('VIDEOS_YTAPI source unresolved:', source)
	youtubeSourceCache.set(source, null)
	return null
}

async function fetchYoutubeUploadsForSource({ sourceName, storyKeywords, originMs, windowDays, fallbackUnknownDateToNow, logger }) {
	let source = await resolveYoutubeSource(sourceName, { logger })
	if (!source) return null

	let maxWanted = YOUTUBE_UPLOADS_PER_SOURCE
	let out = []
	let scanned = 0
	let pageToken = ''
	let lowerBoundMs = Number.isFinite(originMs) ? originMs - windowDays * DAY_MS : NaN
	let maxPages = Math.max(1, Math.ceil(maxWanted / 50))

	for (let pageIndex = 0; pageIndex < maxPages && scanned < maxWanted; pageIndex++) {
		let u = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
		u.searchParams.set('part', 'snippet,contentDetails')
		u.searchParams.set('playlistId', source.uploadsPlaylistId)
		u.searchParams.set('maxResults', String(Math.min(50, maxWanted - scanned)))
		if (pageToken) u.searchParams.set('pageToken', pageToken)

		let json = await youtubeApiGetJson(u, { logger })
		if (!json) break

		let items = Array.isArray(json?.items) ? json.items : []
		if (!items.length) break

		for (let item of items) {
			scanned++
			let snippet = item?.snippet || {}
			let videoId = String(item?.contentDetails?.videoId || snippet?.resourceId?.videoId || '').trim()
			if (!videoId) continue
			let url = normalizeYoutubeUrl(`https://www.youtube.com/watch?v=${videoId}`)
			if (!url) continue
			let title = String(snippet?.title || '').trim()
			let description = String(snippet?.description || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, VERIFY_VIDEO_DESCRIPTION_MAX_CHARS)
			let publishedAt = String(snippet?.publishedAt || '').trim()
			let author = String(snippet?.videoOwnerChannelTitle || snippet?.channelTitle || source.channelTitle || '').trim()
			out.push({
				url,
				source: source.source,
				title,
				description,
				author,
				publishedAt,
			})
		}

		// Playlist is sorted by recency; stop once we clearly passed date window.
		let lastPublished = parseDateValue(items[items.length - 1]?.snippet?.publishedAt)
		if (Number.isFinite(lowerBoundMs) && Number.isFinite(lastPublished) && lastPublished < lowerBoundMs) break

		pageToken = String(json?.nextPageToken || '').trim()
		if (!pageToken) break
	}

	let dateFiltered = filterArticlesByDateWindow(out, { originMs, windowDays, fallbackUnknownDateToNow })
	logger(
		'VIDEOS_YTAPI uploads:',
		`source=${source.source}`,
		`scanned=${scanned}`,
		`raw=${out.length}`,
		`kept=${dateFiltered.kept.length}`,
		`unknown_date=${dateFiltered.unknownDate}`,
		`fallback_today=${dateFiltered.fallbackToToday}`,
		`out_of_window=${dateFiltered.outOfWindow}`,
		`limit=${YOUTUBE_UPLOADS_PER_SOURCE}`,
	)

	let withHits = dateFiltered.kept.map(v => {
		let haystack = `${v.title || ''}\n${v.description || ''}`
		return {
			...v,
			keywordHits: countKeywordHits(haystack, storyKeywords),
		}
	})
	let keywordFiltered = withHits.filter(v => v.keywordHits >= MIN_KEYWORD_HITS)
	if (!keywordFiltered.length) {
		if (withHits.length) {
			logger('VIDEOS_YTAPI source skipped: no keyword hits', `source=${source.source}`)
		}
		keywordFiltered = []
	}

	keywordFiltered = keywordFiltered
		.sort((a, b) => {
			let hitsDelta = (b.keywordHits || 0) - (a.keywordHits || 0)
			if (hitsDelta) return hitsDelta
			let aMs = parseDateValue(a.publishedAt)
			let bMs = parseDateValue(b.publishedAt)
			if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs
			return 0
		})
		.slice(0, YOUTUBE_VERIFY_VIDEOS_PER_SOURCE)
		.map(v => ({
			url: v.url,
			title: v.title,
			author: v.author,
			description: v.description,
			publishedAt: v.publishedAt,
		}))

	return {
		source: source.source,
		channelUrl: source.channelUrl,
		channelTitle: source.channelTitle,
		videos: keywordFiltered,
	}
}

async function chooseRelevantYoutubeUploadVideo({ story, source, channelUrl, channelTitle, videos, currentVideos, logger }) {
	let pool = (videos || [])
		.map(v => ({
			url: normalizeYoutubeUrl(v?.url),
			title: String(v?.title || '').trim(),
			author: String(v?.author || '').trim(),
			description: String(v?.description || '').trim(),
			publishedAt: String(v?.publishedAt || '').trim(),
		}))
		.filter(v => v.url)
		.filter(v => !currentVideos.includes(v.url))
	pool = (await Promise.all(pool.map(v => enrichYoutubeVideoCandidate(v, {
		source,
		channelTitle,
		logger,
	})))).filter(Boolean)
	if (!pool.length) return null

	let candidateSnippet = pool
		.map(v => [v.title, v.description].filter(Boolean).join(' - '))
		.join('\n')
		.slice(0, VERIFY_SNIPPET_MAX_CHARS)

	let decisions = await verifyVideoCandidatesRelevance({
		story,
		candidate: {
			title: `${source} YouTube uploads`,
			source,
			url: channelUrl,
			publishedAt: '',
		},
		candidateSnippet,
		videos: pool,
		logger,
	})

	let matched = []
	for (let video of pool) {
		let verdict = decisions.get(video.url) || { match: false, confidence: 0, reason: 'verify_missing' }
		if (verdict.match) {
			matched.push({ video, verdict })
			continue
		}
		logger(
			'VIDEOS_VERIFY mismatch',
			`source=${source || 'unknown'}`,
			`confidence=${verdict.confidence.toFixed(2)}`,
			`reason=${verdict.reason || 'n/a'}`,
			`video=${video.url}`,
		)
	}
	if (!matched.length) return null

	matched.sort((a, b) => b.verdict.confidence - a.verdict.confidence)
	let picked = matched[0]
	return {
		videoUrl: picked.video.url,
		verdict: picked.verdict,
		meta: {
			title: picked.video.title,
			author: picked.video.author,
			description: picked.video.description,
		},
		totalFound: pool.length,
		relevantFound: matched.length,
		channelTitle: channelTitle || '',
	}
}

async function collectVideosFromYoutubeApi(story, { originMs, windowDays, fallbackUnknownDateToNow, storyKeywords, logger, currentVideos, usedSources, verifyBudget }) {
	if (!youtubeApiEnabledByConfig) {
		if (!youtubeApiDisabledByConfigLogged) {
			youtubeApiDisabledByConfigLogged = true
			logger('VIDEOS_YTAPI skipped: disabled by config (set YOUTUBE_API_ENABLED=1 to enable)')
		}
		return []
	}
	if (!youtubeOauthClient) {
		logger('VIDEOS_YTAPI skipped: OAuth credentials missing (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN)')
		return []
	}
	if (youtubeAuthBroken) {
		if (!youtubeAuthBrokenLogged) {
			youtubeAuthBrokenLogged = true
			logger('VIDEOS_YTAPI skipped: auth disabled for current run', youtubeAuthBrokenReason || 'auth_error')
		}
		return []
	}

	let added = []
	for (let sourceName of TRUSTED_VIDEO_SOURCES) {
		if (currentVideos.length + added.length >= MAX_VIDEO_URLS) break
		if (usedSources.has(sourceName) && MAX_VIDEOS_PER_SOURCE <= 1) continue
		let budgetLeft = Number(verifyBudget?.remaining)
		if (Number.isFinite(budgetLeft) && budgetLeft <= 0) {
			logger('VIDEOS_YTAPI verify budget exhausted', `limit=${YOUTUBE_VERIFY_VIDEOS_PER_STORY}`)
			break
		}

		let loaded = await fetchYoutubeUploadsForSource({
			sourceName,
			storyKeywords,
			originMs,
			windowDays,
			fallbackUnknownDateToNow,
			logger,
		})
		if (!loaded?.videos?.length) continue

		let withHits = loaded.videos.map(v => {
			let haystack = `${v.title || ''}\n${v.description || ''}`
			return {
				...v,
				keywordHits: countKeywordHits(haystack, storyKeywords),
			}
		})
		let videosToVerify = limitVerifyPoolBySignal(withHits, {
			storyKeywords,
			remainingBudget: budgetLeft,
			sourceName: loaded.source,
			logger,
		}).map(v => ({
			url: v.url,
			title: v.title,
			author: v.author,
			description: v.description,
			publishedAt: v.publishedAt,
		}))
		if (!videosToVerify.length) continue
		if (Number.isFinite(budgetLeft)) {
			verifyBudget.remaining = Math.max(0, budgetLeft - videosToVerify.length)
		}

		let selected = await chooseRelevantYoutubeUploadVideo({
			story,
			source: loaded.source,
			channelUrl: loaded.channelUrl,
			channelTitle: loaded.channelTitle,
			videos: videosToVerify,
			currentVideos: currentVideos.concat(added),
			logger,
		})
		if (!selected) continue

		added.push(selected.videoUrl)
		usedSources.add(loaded.source)
		logger(
			'VIDEOS from ytapi channel:',
			loaded.channelUrl,
			`source=${loaded.source}`,
			`picked=1/${videosToVerify.length}`,
			`relevant=${selected.relevantFound}/${videosToVerify.length}`,
			`verify_confidence=${selected.verdict.confidence.toFixed(2)}`,
			selected.meta?.title ? `video_title=${selected.meta.title.slice(0, 80)}` : '',
		)
	}

	return uniq(added).slice(0, MAX_VIDEO_URLS)
}

async function collectVideosFromYoutubeRss(story, { originMs, windowDays, fallbackUnknownDateToNow, storyKeywords, logger, currentVideos, usedSources, verifyBudget }) {
	let added = []
	for (let sourceName of TRUSTED_VIDEO_SOURCES) {
		if (currentVideos.length + added.length >= MAX_VIDEO_URLS) break
		if (usedSources.has(sourceName) && MAX_VIDEOS_PER_SOURCE <= 1) continue
		let budgetLeft = Number(verifyBudget?.remaining)
		if (Number.isFinite(budgetLeft) && budgetLeft <= 0) {
			logger('VIDEOS_YTRSS verify budget exhausted', `limit=${YOUTUBE_VERIFY_VIDEOS_PER_STORY}`)
			break
		}

		let source = await resolveYoutubeRssSource(sourceName, { logger })
		if (!source) continue

		let raw = await fetchYoutubeRssEntriesForSource(source, { logger })
		if (!raw.length) continue

		let dateFiltered = filterArticlesByDateWindow(raw, { originMs, windowDays, fallbackUnknownDateToNow })
		logger(
			'VIDEOS_YTRSS filter:',
			`source=${source.source}`,
			`raw=${raw.length}`,
			`kept=${dateFiltered.kept.length}`,
			`unknown_date=${dateFiltered.unknownDate}`,
			`fallback_today=${dateFiltered.fallbackToToday}`,
			`out_of_window=${dateFiltered.outOfWindow}`,
		)

		let withHits = dateFiltered.kept.map(v => {
			let haystack = `${v.title || ''}\n${v.description || ''}`
			return {
				...v,
				keywordHits: countKeywordHits(haystack, storyKeywords),
			}
		})
		let keywordFiltered = withHits.filter(v => v.keywordHits >= MIN_KEYWORD_HITS)
		if (!keywordFiltered.length) {
			if (withHits.length) {
				logger('VIDEOS_YTRSS source skipped: no keyword hits', `source=${source.source}`)
			}
			keywordFiltered = []
		}

		let videosToVerify = limitVerifyPoolBySignal(keywordFiltered, {
			storyKeywords,
			remainingBudget: budgetLeft,
			sourceName: source.source,
			logger,
		})
			.map(v => ({
				url: v.url,
				title: v.title,
				author: v.author,
				description: v.description,
				publishedAt: v.publishedAt,
			}))
		if (!videosToVerify.length) continue
		if (Number.isFinite(budgetLeft)) {
			verifyBudget.remaining = Math.max(0, budgetLeft - videosToVerify.length)
		}

		let selected = await chooseRelevantYoutubeUploadVideo({
			story,
			source: source.source,
			channelUrl: source.channelUrl,
			channelTitle: source.channelTitle,
			videos: videosToVerify,
			currentVideos: currentVideos.concat(added),
			logger,
		})
		if (!selected) continue

		added.push(selected.videoUrl)
		usedSources.add(source.source)
		logger(
			'VIDEOS from ytrss channel:',
			source.channelUrl,
			`source=${source.source}`,
			`picked=1/${videosToVerify.length}`,
			`relevant=${selected.relevantFound}/${videosToVerify.length}`,
			`verify_confidence=${selected.verdict.confidence.toFixed(2)}`,
			selected.meta?.title ? `video_title=${selected.meta.title.slice(0, 80)}` : '',
		)
	}

	return uniq(added).slice(0, MAX_VIDEO_URLS)
}

function toIsoDateString(ms) {
	if (!Number.isFinite(ms)) return ''
	let iso = new Date(ms).toISOString()
	return iso.replace(/\.\d{3}Z$/, 'Z')
}

function youtubeSearchModeLabel(mode) {
	return mode === 'open' ? 'youtube_search_open' : 'youtube_search_allowlist'
}

function allowsVideoForSearchMode(video, mode) {
	let excluded = isExcludedVideoByChannel({
		source: video?.source,
		channelTitle: video?.channelTitle,
		author: video?.author,
	})
	if (excluded) return false
	if (mode === 'open') return true
	return isAllowlistedVideoByChannel({
		source: video?.source,
		channelTitle: video?.channelTitle,
		author: video?.author,
	})
}

async function searchYoutubeVideosByKeywords(
	story,
	{ originMs, windowDays, fallbackUnknownDateToNow, storyKeywords, logger, mode = 'allowlist' }
) {
	let queries = buildYoutubeSearchQueries(story, storyKeywords, { openFallback: mode === 'open' })
	if (!queries.length) {
		logger('VIDEOS_YTSEARCH skipped: no search queries', `mode=${mode}`)
		return []
	}

	let publishedAfter = Number.isFinite(originMs) ? toIsoDateString(originMs - windowDays * DAY_MS) : ''
	let publishedBefore = Number.isFinite(originMs) ? toIsoDateString(originMs + windowDays * DAY_MS) : ''
	let out = []
	for (let query of queries) {
		let url = new URL('https://www.googleapis.com/youtube/v3/search')
		url.searchParams.set('part', 'snippet')
		url.searchParams.set('type', 'video')
		url.searchParams.set('order', 'date')
		url.searchParams.set('maxResults', String(YOUTUBE_SEARCH_RESULTS_PER_QUERY))
		url.searchParams.set('q', query)
		url.searchParams.set('videoEmbeddable', 'true')
		if (publishedAfter) url.searchParams.set('publishedAfter', publishedAfter)
		if (publishedBefore) url.searchParams.set('publishedBefore', publishedBefore)

		let json = await youtubeApiGetJson(url, { logger })
		if (!json) continue

		let items = Array.isArray(json?.items) ? json.items : []
		let added = 0
		for (let item of items) {
			let videoId = String(item?.id?.videoId || '').trim()
			if (!videoId) continue
			let watchUrl = normalizeYoutubeUrl(`https://www.youtube.com/watch?v=${videoId}`)
			if (!watchUrl) continue
			let snippet = item?.snippet || {}
			let channelTitle = String(snippet?.channelTitle || '').trim()
			let candidate = {
				url: watchUrl,
				source: channelTitle,
				channelTitle,
				author: channelTitle,
				title: String(snippet?.title || '').replace(/\s+/g, ' ').trim(),
				description: String(snippet?.description || '').replace(/\s+/g, ' ').trim().slice(0, VERIFY_VIDEO_DESCRIPTION_MAX_CHARS),
				publishedAt: String(snippet?.publishedAt || '').trim(),
				query,
			}
			out.push(candidate)
			added++
		}
		logger('VIDEOS_YTSEARCH query:', `mode=${mode}`, `hits=${added}`, `q=${query}`)
	}

	let deduped = uniqByUrl(out)
	let modeFiltered = deduped.filter(v => allowsVideoForSearchMode(v, mode))
	let skippedByMode = deduped.length - modeFiltered.length
	if (skippedByMode > 0) {
		logger('VIDEOS_YTSEARCH channel-filter:', `mode=${mode}`, `kept=${modeFiltered.length}/${deduped.length}`)
	}

	let dateFiltered = filterArticlesByDateWindow(modeFiltered, { originMs, windowDays, fallbackUnknownDateToNow })
	let withHits = dateFiltered.kept.map(v => {
		let haystack = `${v.title || ''}\n${v.description || ''}\n${v.channelTitle || ''}`
		return {
			...v,
			keywordHits: countKeywordHits(haystack, storyKeywords),
		}
	})
	let keywordFiltered = withHits.filter(v => v.keywordHits >= MIN_KEYWORD_HITS)
	if (!keywordFiltered.length && withHits.length) {
		// In some multilingual cases query/title can be relevant while token overlap is weak.
		keywordFiltered = withHits.slice(0, Math.min(withHits.length, Math.max(3, YOUTUBE_VERIFY_VIDEOS_PER_SOURCE)))
		logger('VIDEOS_YTSEARCH keyword fallback:', `mode=${mode}`, `kept=${keywordFiltered.length}/${withHits.length}`)
	}

	keywordFiltered.sort((a, b) => {
		let hitsDelta = (b.keywordHits || 0) - (a.keywordHits || 0)
		if (hitsDelta) return hitsDelta
		let aMs = parseDateValue(a.publishedAt)
		let bMs = parseDateValue(b.publishedAt)
		if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs
		return 0
	})

	logger(
		'VIDEOS_YTSEARCH summary:',
		`mode=${mode}`,
		`queries=${queries.length}`,
		`raw=${out.length}`,
		`deduped=${deduped.length}`,
		`mode_kept=${modeFiltered.length}`,
		`date_kept=${dateFiltered.kept.length}`,
		`keyword_kept=${keywordFiltered.length}`,
	)
	return keywordFiltered
}

async function collectVideosFromYoutubeKeywordSearch(
	story,
	{ originMs, windowDays, fallbackUnknownDateToNow, storyKeywords, logger, currentVideos, verifyBudget, mode = 'allowlist' }
) {
	if (!youtubeApiEnabledByConfig) return []
	if (!youtubeOauthClient) return []
	if (youtubeAuthBroken) return []

	if (currentVideos.length >= MAX_VIDEO_URLS) return []
	let budgetLeft = Number(verifyBudget?.remaining)
	if (Number.isFinite(budgetLeft) && budgetLeft <= 0) {
		logger('VIDEOS_YTSEARCH verify budget exhausted', `mode=${mode}`, `limit=${YOUTUBE_VERIFY_VIDEOS_PER_STORY}`)
		return []
	}

	let found = await searchYoutubeVideosByKeywords(story, {
		originMs,
		windowDays,
		fallbackUnknownDateToNow,
		storyKeywords,
		logger,
		mode,
	})
	if (!found.length) return []

	let videosToVerify = limitVerifyPoolBySignal(found, {
		storyKeywords,
		remainingBudget: budgetLeft,
		sourceName: youtubeSearchModeLabel(mode),
		logger,
	}).map(v => ({
		url: v.url,
		title: v.title,
		author: v.author || v.channelTitle,
		description: v.description,
		publishedAt: v.publishedAt,
	}))
	if (!videosToVerify.length) return []
	if (Number.isFinite(budgetLeft)) {
		verifyBudget.remaining = Math.max(0, budgetLeft - videosToVerify.length)
	}

	let sourceLabel = youtubeSearchModeLabel(mode)
	let selected = await chooseRelevantYoutubeUploadVideo({
		story,
		source: sourceLabel,
		channelUrl: 'https://www.youtube.com',
		channelTitle: sourceLabel,
		videos: videosToVerify,
		currentVideos,
		logger,
	})
	if (!selected) return []

	logger(
		'VIDEOS from ytsearch:',
		`mode=${mode}`,
		`picked=1/${videosToVerify.length}`,
		`relevant=${selected.relevantFound}/${videosToVerify.length}`,
		`verify_confidence=${selected.verdict.confidence.toFixed(2)}`,
		selected.meta?.title ? `video_title=${selected.meta.title.slice(0, 80)}` : '',
	)
	return [selected.videoUrl]
}

function buildGptVideoWebSearchPayloads(story, storyKeywords) {
	if (!videoWebSearchEnabled || !openai) return []
	let querySeeds = buildYoutubeSearchQueries(story, storyKeywords, { openFallback: true })
	let basePayload = {
		articleTitle: String(story?.articleTitle || '').trim(),
		titleEn: String(story?.titleEn || '').trim(),
		titleRu: String(story?.titleRu || '').trim(),
		url: String(story?.usedUrl || story?.url || '').trim(),
		date: String(story?.date || '').trim(),
		keywords: (storyKeywords || []).slice(0, 12),
		querySeeds: querySeeds.slice(0, Math.max(YOUTUBE_SEARCH_QUERIES, 4)),
		allowlistChannels: uniq(YOUTUBE_CHANNEL_ALLOWLIST_TERMS).slice(0, 220),
		textSnippet: String(story?.text || '').replace(/\s+/g, ' ').trim().slice(0, 1800),
		maxCandidates: VIDEO_WEBSEARCH_MAX_CANDIDATES,
	}
	return [
		{
			name: 'exact_story',
			payload: {
				...basePayload,
				strategyHint: 'exact_story',
				querySeeds: querySeeds.slice(0, Math.max(YOUTUBE_SEARCH_QUERIES, 4)),
				maxCandidates: VIDEO_WEBSEARCH_MAX_CANDIDATES,
			},
		},
		{
			name: 'allowlist_focus',
			payload: {
				...basePayload,
				strategyHint: 'allowlist_focus',
				querySeeds: querySeeds.slice(0, Math.min(3, Math.max(YOUTUBE_SEARCH_QUERIES, 3))),
				keywords: (storyKeywords || []).slice(0, 8),
				maxCandidates: VIDEO_WEBSEARCH_MAX_CANDIDATES,
			},
		},
		{
			name: 'context_focus',
			payload: {
					...basePayload,
					strategyHint: 'context_focus',
					querySeeds: uniq([
						...(querySeeds || []).slice(0, 2),
						[String(storyOriginalTitle(story) || '').trim(), ...(storyKeywords || []).slice(0, 5)].filter(Boolean).join(' '),
					]).slice(0, Math.max(YOUTUBE_SEARCH_QUERIES, 3)),
				keywords: (storyKeywords || []).slice(0, 10),
				textSnippet: String(story?.text || '').replace(/\s+/g, ' ').trim().slice(0, 2600),
				maxCandidates: VIDEO_WEBSEARCH_MAX_CANDIDATES,
			},
		},
	].slice(0, VIDEO_WEBSEARCH_PARALLEL_REQUESTS)
}

async function searchYoutubeVideosViaGptWebSearch(story, { storyKeywords, logger }) {
	let payloads = buildGptVideoWebSearchPayloads(story, storyKeywords)
	if (!payloads.length) return []

	try {
		let system = await getPrompt(spreadsheetId, VIDEO_WEBSEARCH_PROMPT_NAME)
		let settled = await Promise.allSettled(payloads.map(async ({ name, payload }) => {
			logger(
				'VIDEOS gpt-websearch request:',
				`strategy=${name}`,
				`model=${videoWebSearchModel}`,
				`query_seeds=${(payload.querySeeds || []).length}`,
				`keywords=${(payload.keywords || []).length}`,
			)
			let built = buildResponsesWebSearchRequest({
				model: videoWebSearchModel,
				system,
				user: JSON.stringify(payload),
				temperature: VIDEO_WEBSEARCH_TEMPERATURE,
				webSearchOptions: videoWebSearchOptions(),
				responseFormat: VIDEO_WEBSEARCH_RESPONSE_FORMAT,
				reasoningEffort: VIDEO_WEBSEARCH_REASONING_EFFORT,
			})
			let res = await openai.post('/responses', { body: built.request })
			estimateAndLogCost({
				task: 'video_websearch',
				model: videoWebSearchModel,
				usage: res?.usage,
				response: res,
				fallbackWebSearchCalls: 1,
				logger,
			})
			let raw = extractResponseOutputText(res)
			let videos = parseGptVideoWebSearchOutput(raw).slice(0, VIDEO_WEBSEARCH_MAX_CANDIDATES)
			logger(
				'VIDEOS gpt-websearch result:',
				`strategy=${name}`,
				`model=${videoWebSearchModel}`,
				`candidates=${videos.length}`,
			)
			return videos
		}))
		let videos = uniqByUrl(
			settled
				.filter(result => result.status === 'fulfilled')
				.flatMap(result => result.value || [])
		).slice(0, VIDEO_WEBSEARCH_MAX_CANDIDATES)
		logger(
			'VIDEOS gpt-websearch merged:',
			`model=${videoWebSearchModel}`,
			`parallel=${payloads.length}`,
			`candidates=${videos.length}`,
		)
		return videos
	} catch (e) {
		logger('VIDEOS gpt-websearch failed', String(e?.message || e))
		return []
	}
}

async function collectVideosFromGptWebSearch(
	story,
	{ originMs, windowDays, fallbackUnknownDateToNow, storyKeywords, logger, currentVideos, verifyBudget }
) {
	if (!videoWebSearchEnabled || !openai) return []
	if (currentVideos.length >= MAX_VIDEO_URLS) return []

	let budgetLeft = Number(verifyBudget?.remaining)
	if (Number.isFinite(budgetLeft) && budgetLeft <= 0) return []

	let found = await searchYoutubeVideosViaGptWebSearch(story, { storyKeywords, logger })
	if (!found.length) return []

	let enriched = (await Promise.all(found.map(async row => {
		let url = normalizeYoutubeUrl(row?.url)
		if (!url || currentVideos.includes(url)) return null
		let source = String(row?.source || '').trim()
		return await enrichYoutubeVideoCandidate({
			url,
			source,
			title: String(row?.title || '').trim(),
			author: source,
			description: '',
			publishedAt: String(row?.publishedAt || '').trim(),
		}, {
			source,
			channelTitle: source,
			logger,
		})
	}))).filter(Boolean)
	if (!enriched.length) return []

	let dateFiltered = filterArticlesByDateWindow(enriched, { originMs, windowDays, fallbackUnknownDateToNow })
	let withHits = dateFiltered.kept.map(v => {
		let haystack = `${v.title || ''}\n${v.description || ''}\n${v.channelTitle || ''}`
		return {
			...v,
			keywordHits: countKeywordHits(haystack, storyKeywords),
			allowlisted: isAllowlistedVideoByChannel(v),
		}
	})
	if (!withHits.length) return []

	withHits.sort((a, b) => {
		if (a.allowlisted !== b.allowlisted) return a.allowlisted ? -1 : 1
		let hitsDelta = (b.keywordHits || 0) - (a.keywordHits || 0)
		if (hitsDelta) return hitsDelta
		let aMs = parseDateValue(a.publishedAt)
		let bMs = parseDateValue(b.publishedAt)
		if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs
		return 0
	})

	let cap = Math.min(
		VIDEO_WEBSEARCH_MAX_CANDIDATES,
		YOUTUBE_VERIFY_VIDEOS_PER_SOURCE,
		Number.isFinite(budgetLeft) ? Math.max(0, budgetLeft) : YOUTUBE_VERIFY_VIDEOS_PER_SOURCE
	)
	if (cap <= 0) return []
	let videosToVerify = withHits.slice(0, cap).map(v => ({
		url: v.url,
		title: v.title,
		author: v.author || v.channelTitle,
		description: v.description,
		publishedAt: v.publishedAt,
	}))
	if (!videosToVerify.length) return []

	if (Number.isFinite(budgetLeft)) {
		verifyBudget.remaining = Math.max(0, budgetLeft - videosToVerify.length)
	}

	let selected = await chooseRelevantYoutubeUploadVideo({
		story,
		source: 'gpt-websearch',
		channelUrl: '',
		channelTitle: 'gpt-websearch',
		videos: videosToVerify,
		currentVideos,
		logger,
	})
	if (!selected) return []

	logger(
		'VIDEOS from gpt-websearch:',
		`picked=1/${videosToVerify.length}`,
		`relevant=${selected.relevantFound}/${videosToVerify.length}`,
		`verify_confidence=${selected.verdict.confidence.toFixed(2)}`,
		selected.meta?.title ? `video_title=${selected.meta.title.slice(0, 80)}` : '',
	)
	return [selected.videoUrl]
}

async function chooseRelevantVideo({ story, candidate, candidateHtml, candidateSnippet, currentVideos, logger }) {
	let found = extractYoutubeUrlsFromHtml(candidateHtml || candidateSnippet)
	found = found.filter(url => !currentVideos.includes(url))
	if (!found.length) return null

	let attempts = found.slice(0, MAX_VERIFY_VIDEOS_PER_PAGE)
	let videos = (await Promise.all(attempts.map(async (videoUrl) => {
		return await enrichYoutubeVideoCandidate({
			url: videoUrl,
			source: candidate?.source,
		}, {
			source: candidate?.source,
			logger,
		})
	}))).filter(Boolean)
	if (!videos.length) return null

	let decisions = await verifyVideoCandidatesRelevance({
		story,
		candidate,
		candidateSnippet,
		videos,
		logger,
	})

	let matched = []
	for (let video of videos) {
		let verdict = decisions.get(video.url) || { match: false, confidence: 0, reason: 'verify_missing' }
		if (verdict.match) {
			matched.push({ video, verdict })
			continue
		}
		logger(
			'VIDEOS_VERIFY mismatch',
			`source=${candidate?.source || 'unknown'}`,
			`confidence=${verdict.confidence.toFixed(2)}`,
			`reason=${verdict.reason || 'n/a'}`,
			`video=${video.url}`,
		)
	}
	if (!matched.length) return null

	matched.sort((a, b) => b.verdict.confidence - a.verdict.confidence)
	let picked = matched[0]

	return {
		videoUrl: picked.video.url,
		verdict: picked.verdict,
		meta: {
			title: picked.video.title,
			author: picked.video.author,
			description: picked.video.description,
		},
		totalFound: found.length,
		relevantFound: matched.length,
		checked: videos.length,
	}
}

async function collectVideosFromExactArticleHtml(story, { logger, currentVideos }) {
	let html = String(story?.html || '').trim()
	if (!html) {
		logger('VIDEOS exact article html: missing')
		return []
	}

	let found = extractYoutubeUrlsFromHtml(html)
	logger('VIDEOS exact article html candidates:', found.length)
	if (!found.length) return []

	let selected = await chooseRelevantVideo({
		story,
		candidate: {
			url: normalizeHttpUrl(story?.usedUrl || story?.url),
			source: String(story?.source || '').trim(),
			title: String(story?.articleTitle || story?.titleEn || story?.titleRu || '').trim(),
			publishedAt: String(story?.date || '').trim(),
		},
		candidateHtml: html,
		candidateSnippet: htmlToSnippet(html, VERIFY_SNIPPET_MAX_CHARS),
		currentVideos,
		logger,
	})
	if (!selected) return []

	logger(
		'VIDEOS from exact article html:',
		`picked=1/${selected.checked || selected.totalFound}`,
		`relevant=${selected.relevantFound || 1}/${selected.totalFound}`,
		`verify_confidence=${selected.verdict.confidence.toFixed(2)}`,
		selected.meta?.title ? `video_title=${selected.meta.title.slice(0, 80)}` : '',
	)
	return [selected.videoUrl]
}

async function collectVideosFromTrustedPages({
	story,
	candidates,
	logger,
	videos,
	usedSources,
	checkedSourcePages,
	hostFailures,
	visitedCandidateUrls,
}) {
	for (let candidate of candidates || []) {
		if (videos.length >= MAX_VIDEO_URLS) break
		let url = normalizeHttpUrl(candidate?.url)
		if (!url) continue
		if (visitedCandidateUrls.has(url)) continue
		visitedCandidateUrls.add(url)

		let sourceName = resolveTrustedSourceByUrl(url) || candidate.source || ''
		if (sourceName && usedSources.has(sourceName) && MAX_VIDEOS_PER_SOURCE <= 1) continue
		if (sourceName) {
			let checked = checkedSourcePages.get(sourceName) || 0
			if (checked >= MAX_SOURCE_PAGES_TO_CHECK) {
				logger('VIDEOS source page limit skip:', `source=${sourceName}`, `limit=${MAX_SOURCE_PAGES_TO_CHECK}`, `url=${url}`)
				continue
			}
			checkedSourcePages.set(sourceName, checked + 1)
		}

		let host = hostFromUrl(url)
		let hostState = host ? hostFailures.get(host) : null
		if (host && hostState?.blocked) {
			logger(
				'VIDEOS host cooldown skip:',
				`host=${host}`,
				`status=${hostState.lastStatus || 'n/a'}`,
				`fails=${hostState.count}/${HOST_COOLDOWN_FAILURE_LIMIT}`,
				`url=${url}`,
			)
			continue
		}

		let page = await fetchCandidatePage(url)
		if (!page.ok) {
			if (host && HOST_COOLDOWN_STATUS_CODES.has(page.status)) {
				let next = hostState || { count: 0, lastStatus: 0, blocked: false }
				next.count++
				next.lastStatus = page.status
				if (next.count >= HOST_COOLDOWN_FAILURE_LIMIT) next.blocked = true
				hostFailures.set(host, next)
				logger(
					'VIDEOS host failure:',
					`host=${host}`,
					`status=${page.status}`,
					`fails=${next.count}/${HOST_COOLDOWN_FAILURE_LIMIT}`,
					`cooldown=${next.blocked ? 'enabled' : 'pending'}`,
					`url=${url}`,
				)
			} else {
				logger(
					'VIDEOS page fetch failed:',
					host ? `host=${host}` : 'host=n/a',
					`status=${page.status || 'n/a'}`,
					`error=${page.error || 'n/a'}`,
					`url=${url}`,
				)
			}
			continue
		}
		if (host && hostState) hostFailures.delete(host)

		let candidateSnippet = htmlToSnippet(page.html, VERIFY_SNIPPET_MAX_CHARS)
		if (!candidateSnippet) continue

		let selected = await chooseRelevantVideo({
			story,
			candidate: { ...candidate, url, source: sourceName },
			candidateHtml: page.html,
			candidateSnippet,
			currentVideos: videos,
			logger,
		})
		if (!selected) continue

		videos.push(selected.videoUrl)
		if (sourceName) usedSources.add(sourceName)
		logger(
			'VIDEOS from trusted page:',
			url,
			`source=${sourceName || 'unknown'}`,
			`picked=1/${selected.checked || selected.totalFound}`,
			`relevant=${selected.relevantFound || 1}/${selected.totalFound}`,
			`verify_confidence=${selected.verdict.confidence.toFixed(2)}`,
			selected.meta?.title ? `video_title=${selected.meta.title.slice(0, 80)}` : '',
		)
	}
}

export function describeVideoCollectionSettings() {
	let verifyLabel = videoVerifyEnabled
		? `verify=gpt model=${videoVerifyModel} reasoning=${VERIFY_REASONING_EFFORT} min_conf=${VERIFY_MIN_CONFIDENCE}`
		: 'verify=off'
	let ytLabel = youtubeOauthClient
		? `ytapi=primary auth=oauth uploads_per_source=${YOUTUBE_UPLOADS_PER_SOURCE}`
		: youtubeApiEnabledByConfig
			? 'ytapi=off missing_oauth_credentials'
			: 'ytapi=off config_disabled'
	let ytSearchLabel = `ytsearch=allowlist_then_open search_queries=${YOUTUBE_SEARCH_QUERIES} results_per_query=${YOUTUBE_SEARCH_RESULTS_PER_QUERY} open_fallback=${YOUTUBE_OPEN_FALLBACK_ENABLED ? 'on' : 'off'}`
	let gptWebLabel = videoWebSearchEnabled
		? `gpt_websearch=on model=${videoWebSearchModel} parallel=${VIDEO_WEBSEARCH_PARALLEL_REQUESTS} max_candidates=${VIDEO_WEBSEARCH_MAX_CANDIDATES}`
		: 'gpt_websearch=off'
	return `strategy=article_html_then_ytapi_then_ytrss_then_ytsearch_then_pages_then_open_search_then_gpt_websearch ${verifyLabel} ${ytLabel} ytrss=fallback ${ytSearchLabel} ${gptWebLabel} date_window=+/-${DATE_WINDOW_DAYS}d fallback_if_missing=today+/-${FALLBACK_DATE_WINDOW_DAYS}d max_video_urls=${MAX_VIDEO_URLS} max1video_per_source excluded_channels=Al_Jazeera yt_verify_per_source=${YOUTUBE_VERIFY_VIDEOS_PER_SOURCE} yt_verify_per_story=${YOUTUBE_VERIFY_VIDEOS_PER_STORY} trusted_sources=${TRUSTED_VIDEO_SOURCES.join(' | ')}`
}

export async function collectVideosFromTrustedSources(story, { logger = console.log } = {}) {
	let seedUrls = uniq([
		normalizeHttpUrl(story?.usedUrl),
		normalizeHttpUrl(story?.url),
		...parseUrlLines(story?.alternativeUrls),
	].filter(Boolean)).slice(0, 4)

	let storyKeywords = buildStoryKeywords(story || {})
	if (storyKeywords.length) logger('VIDEOS story keywords:', storyKeywords.slice(0, 8).join(' '))

	let dateWindow = buildDateWindowFromStory(story)
	let originMs = dateWindow.originMs
	let windowDays = dateWindow.windowDays
	let fallbackUnknownDateToNow = dateWindow.fallbackUnknownDateToNow
	let keepUnknownAfterSerp = dateWindow.keepUnknownAfterSerp
	if (dateWindow.originFallbackToToday) {
		logger('VIDEOS origin date missing, fallback to today:', new Date(originMs).toISOString(), `window=+/-${windowDays}d`)
	} else {
		logger('VIDEOS origin date:', new Date(originMs).toISOString(), `window=+/-${windowDays}d`)
	}

	let videos = []
	let usedSources = new Set()
	let verifyBudget = { remaining: YOUTUBE_VERIFY_VIDEOS_PER_STORY }
	logger(
		'VIDEOS verify budget:',
		`yt_verify_per_source=${YOUTUBE_VERIFY_VIDEOS_PER_SOURCE}`,
		`yt_verify_per_story=${YOUTUBE_VERIFY_VIDEOS_PER_STORY}`,
	)

	let exactArticleVideos = await collectVideosFromExactArticleHtml(story, {
		logger,
		currentVideos: videos,
	})
	if (exactArticleVideos.length) videos = uniq(videos.concat(exactArticleVideos)).slice(0, MAX_VIDEO_URLS)
	if (videos.length >= MAX_VIDEO_URLS) return videos.join('\n')

	let ytapiVideos = await collectVideosFromYoutubeApi(story, {
		originMs,
		windowDays,
		fallbackUnknownDateToNow,
		storyKeywords,
		logger,
		currentVideos: videos,
		usedSources,
		verifyBudget,
	})
	if (ytapiVideos.length) videos = uniq(videos.concat(ytapiVideos)).slice(0, MAX_VIDEO_URLS)
	if (videos.length >= MAX_VIDEO_URLS) return videos.join('\n')

	let shouldTryYtRss = !ytapiVideos.length || youtubeAuthBroken || !youtubeOauthClient
	if (shouldTryYtRss && videos.length < MAX_VIDEO_URLS) {
		let ytrssVideos = await collectVideosFromYoutubeRss(story, {
			originMs,
			windowDays,
			fallbackUnknownDateToNow,
			storyKeywords,
			logger,
			currentVideos: videos,
			usedSources,
			verifyBudget,
		})
		if (ytrssVideos.length) videos = uniq(videos.concat(ytrssVideos)).slice(0, MAX_VIDEO_URLS)
		if (videos.length >= MAX_VIDEO_URLS) return videos.join('\n')
	}

	if (videos.length < MAX_VIDEO_URLS) {
		let ytsearchAllowlist = await collectVideosFromYoutubeKeywordSearch(story, {
			originMs,
			windowDays,
			fallbackUnknownDateToNow,
			storyKeywords,
			logger,
			currentVideos: videos,
			verifyBudget,
			mode: 'allowlist',
		})
		if (ytsearchAllowlist.length) videos = uniq(videos.concat(ytsearchAllowlist)).slice(0, MAX_VIDEO_URLS)
		if (videos.length >= MAX_VIDEO_URLS) return videos.join('\n')
	}

	if (videos.length < MAX_VIDEO_URLS) {
		let gptWeb = await collectVideosFromGptWebSearch(story, {
			originMs,
			windowDays,
			fallbackUnknownDateToNow,
			storyKeywords,
			logger,
			currentVideos: videos,
			verifyBudget,
		})
		if (gptWeb.length) videos = uniq(videos.concat(gptWeb)).slice(0, MAX_VIDEO_URLS)
		if (videos.length >= MAX_VIDEO_URLS) return videos.join('\n')
	}

	if (youtubeAuthBroken) {
		logger('VIDEOS_YTAPI disabled -> switching to page/search fallback only', youtubeAuthBrokenReason || 'auth_error')
	}

	if (!seedUrls.length) {
		logger('VIDEOS no seed urls for trusted pages; using youtube-search fallback only')
		if (videos.length < MAX_VIDEO_URLS && YOUTUBE_OPEN_FALLBACK_ENABLED) {
			let ytsearchOpen = await collectVideosFromYoutubeKeywordSearch(story, {
				originMs,
				windowDays,
				fallbackUnknownDateToNow,
				storyKeywords,
				logger,
				currentVideos: videos,
				verifyBudget,
				mode: 'open',
			})
			if (ytsearchOpen.length) videos = uniq(videos.concat(ytsearchOpen)).slice(0, MAX_VIDEO_URLS)
		}
		return videos.join('\n')
	}

	let candidates = seedUrls
		.map(seed => toCandidate({ url: seed, source: story?.source, publishedAt: story?.date }, story?.source))
		.filter(Boolean)

	let newsApiCalls = 0
	let newsapiKeywordOverride = storyKeywords.slice(0, 8)
	let newsapiOpts = newsapiKeywordOverride.length >= 2 ? { keywords: newsapiKeywordOverride } : undefined
	let primarySeed = seedUrls[0]
	if (primarySeed) {
		newsApiCalls++
		let raw = (await findAlternativeArticles(primarySeed, newsapiOpts)) || []
		let dateFiltered = filterArticlesByDateWindow(raw, { originMs, windowDays, fallbackUnknownDateToNow })
		logger(
			'VIDEOS newsapi primary:',
			`raw=${raw.length}`,
			`kept=${dateFiltered.kept.length}`,
			`unknown_date=${dateFiltered.unknownDate}`,
			`fallback_today=${dateFiltered.fallbackToToday}`,
			`out_of_window=${dateFiltered.outOfWindow}`,
		)
		for (let item of dateFiltered.kept) {
			candidates.push(toCandidate(item))
		}
	}

	let trustedInInitial = candidates.filter(v => isTrustedSourcePage(v.url)).length
	if (trustedInInitial < 2 && seedUrls.length > 1) {
		let secondarySeed = seedUrls[1]
		if (secondarySeed && secondarySeed !== primarySeed) {
			newsApiCalls++
			let raw = (await findAlternativeArticles(secondarySeed, newsapiOpts)) || []
			let dateFiltered = filterArticlesByDateWindow(raw, { originMs, windowDays, fallbackUnknownDateToNow })
			logger(
				'VIDEOS newsapi secondary:',
				`raw=${raw.length}`,
				`kept=${dateFiltered.kept.length}`,
				`unknown_date=${dateFiltered.unknownDate}`,
				`fallback_today=${dateFiltered.fallbackToToday}`,
				`out_of_window=${dateFiltered.outOfWindow}`,
			)
			for (let item of dateFiltered.kept) {
				candidates.push(toCandidate(item))
			}
		}
	}

	candidates = uniqByUrl(candidates.filter(Boolean))
	logger(
		'VIDEOS candidates:',
		`seeds=${seedUrls.length}`,
		`newsapi_calls=${newsApiCalls}`,
		`total=${candidates.length}`,
	)

	let trustedInitial = filterTrustedCandidates(candidates, {
		originMs,
		storyKeywords,
		logger,
		stage: 'initial',
		keepUnknownDates: false,
		windowDays,
		fallbackUnknownDateToNow,
	})
	let checkedSourcePages = new Map()
	let hostFailures = new Map()
	let visitedCandidateUrls = new Set()

	let trusted = uniqByUrl(trustedInitial).slice(0, MAX_CANDIDATE_PAGES)
	logger('VIDEOS trusted candidates initial:', trusted.length)
	if (trusted.length) {
		await collectVideosFromTrustedPages({
			story,
			candidates: trusted,
			logger,
			videos,
			usedSources,
			checkedSourcePages,
			hostFailures,
			visitedCandidateUrls,
		})
	}

	if (videos.length < MAX_VIDEO_URLS) {
		let serp = await searchTrustedPagesViaSerpApi(story, { originMs, storyKeywords, logger, windowDays })
		let trustedAfterSerp = filterTrustedCandidates(trusted.concat(serp), {
			originMs,
			storyKeywords,
			logger,
			stage: 'after_serpapi',
			keepUnknownDates: keepUnknownAfterSerp,
			windowDays,
			fallbackUnknownDateToNow,
		})
		let trustedFallbackOnly = uniqByUrl(trustedAfterSerp)
			.filter(v => !visitedCandidateUrls.has(normalizeHttpUrl(v?.url)))
			.slice(0, MAX_CANDIDATE_PAGES)
		logger('VIDEOS trusted candidates fallback:', trustedFallbackOnly.length)
		if (trustedFallbackOnly.length) {
			await collectVideosFromTrustedPages({
				story,
				candidates: trustedFallbackOnly,
				logger,
				videos,
				usedSources,
				checkedSourcePages,
				hostFailures,
				visitedCandidateUrls,
			})
		}
	}

	if (videos.length < MAX_VIDEO_URLS && YOUTUBE_OPEN_FALLBACK_ENABLED) {
		let ytsearchOpen = await collectVideosFromYoutubeKeywordSearch(story, {
			originMs,
			windowDays,
			fallbackUnknownDateToNow,
			storyKeywords,
			logger,
			currentVideos: videos,
			verifyBudget,
			mode: 'open',
		})
		if (ytsearchOpen.length) videos = uniq(videos.concat(ytsearchOpen)).slice(0, MAX_VIDEO_URLS)
	}

	return uniq(videos).slice(0, MAX_VIDEO_URLS).join('\n')
}
