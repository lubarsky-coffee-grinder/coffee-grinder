import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { readEnv } from './env.js'
import { getPrompt } from './prompts.js'
import { estimateAndLogCost } from './cost.js'
import { collectVideosFromTrustedSources, describeVideoCollectionSettings } from './video-links.js'
import {
	buildWebSearchWithTemperatureResponseBody,
	extractResponseOutputText,
	resolveWebSearchTemperatureConfig,
} from './openai-websearch-templates.js'

const openai = new OpenAI()

const DEFAULT_FACTS_MODEL = 'gpt-4o'
const DEFAULT_TITLE_LOOKUP_MODEL = DEFAULT_FACTS_MODEL
const DEFAULT_ARGUMENTS_MODEL = 'gpt-5.2'
const DEFAULT_ALT_URL_MODEL = 'gpt-5.4'
const ARGUMENTS_LABEL = 'ARGUMENTS'
const ARGUMENTS_REASONING_EFFORT = 'high'
const ARGUMENTS_SEARCH_CONTEXT_SIZE = 'medium'
const ARGUMENTS_USER_LOCATION = { type: 'approximate' }
const ARGUMENTS_VECTOR_STORE_IDS = ['vs_699e12566b64819196d2870def837004']
const ALT_URL_REASONING_EFFORT = 'low'
const ALT_URL_PARALLEL_REQUESTS = 3

const FACTS_TEMPERATURE = 0
const TITLE_LOOKUP_TEMPERATURE = 0
const FACTS_REASONING_EFFORT = 'low'
const TITLE_LOOKUP_REASONING_EFFORT = 'low'

const explicitFactsModel = readEnv('OPENAI_FACTS_MODEL')
const factsModel = explicitFactsModel || DEFAULT_FACTS_MODEL
const factsModelSource = explicitFactsModel ? 'OPENAI_FACTS_MODEL' : 'default'

const explicitTitleLookupModel = readEnv('OPENAI_TITLE_LOOKUP_MODEL')
const titleLookupModel = explicitTitleLookupModel || factsModel || DEFAULT_TITLE_LOOKUP_MODEL
const titleLookupModelSource = explicitTitleLookupModel
	? 'OPENAI_TITLE_LOOKUP_MODEL'
	: explicitFactsModel
		? 'OPENAI_FACTS_MODEL'
		: 'default'

const explicitArgumentsModel = readEnv('OPENAI_ARGUMENTS_MODEL')
const argumentsModel = explicitArgumentsModel || DEFAULT_ARGUMENTS_MODEL
const argumentsModelSource = explicitArgumentsModel
	? 'OPENAI_ARGUMENTS_MODEL'
	: 'default'

const explicitAlternativeUrlModel = readEnv('OPENAI_ALTERNATIVE_NEWS_MODEL')
const alternativeUrlModel = explicitAlternativeUrlModel || DEFAULT_ALT_URL_MODEL
const alternativeUrlModelSource = explicitAlternativeUrlModel
	? 'OPENAI_ALTERNATIVE_NEWS_MODEL'
	: 'default'
const resolvedArgumentsVectorStoreIds = ARGUMENTS_VECTOR_STORE_IDS

const FACTS_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'news_facts',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				facts: {
					type: 'array',
					items: { type: 'string' },
					minItems: 0,
					maxItems: 12,
				},
			},
			required: ['facts'],
		},
		strict: true,
	},
}

const ARGUMENTS_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'news_arguments',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				arguments: {
					type: 'array',
					items: { type: 'string' },
					minItems: 0,
					maxItems: 5,
				},
			},
			required: ['arguments'],
		},
		strict: true,
	},
}

const TITLE_LOOKUP_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'title_lookup',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				titleEn: { type: 'string' },
				titleRu: { type: 'string' },
				extra: { type: 'string' },
			},
			required: ['titleEn', 'titleRu', 'extra'],
		},
		strict: true,
	},
}

const ALT_URL_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'alternative_url_search',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				candidates: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							url: { type: 'string' },
							source: { type: 'string' },
							title: { type: 'string' },
							publishedAt: { type: 'string' },
							reason: { type: 'string' },
						},
						required: ['url', 'source', 'title', 'publishedAt', 'reason'],
					},
					minItems: 0,
					maxItems: 6,
				},
			},
			required: ['candidates'],
		},
		strict: true,
	},
}

function normalizeHttpUrl(value) {
	try {
		let url = new URL(String(value || '').trim())
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
		return url.toString()
	} catch {
		return ''
	}
}

function sourceFromUrl(value) {
	try {
		return new URL(String(value || '').trim()).hostname.toLowerCase().replace(/^www\./, '')
	} catch {
		return ''
	}
}

function webSearchOptions() {
	let search_context_size = readEnv('OPENAI_WEBSEARCH_CONTEXT_SIZE')
	let country = readEnv('OPENAI_WEBSEARCH_COUNTRY')
	let city = readEnv('OPENAI_WEBSEARCH_CITY')
	let region = readEnv('OPENAI_WEBSEARCH_REGION')
	let timezone = readEnv('OPENAI_WEBSEARCH_TIMEZONE')

	let opts = {}
	if (search_context_size) opts.search_context_size = search_context_size

	if (country || city || region || timezone) {
		opts.user_location = {
			type: 'approximate',
			country,
			city,
			region,
			timezone,
		}
	}

	return opts
}

function formatWebSearchOptions(opts) {
	let parts = []
	if (opts?.search_context_size) parts.push(`context=${opts.search_context_size}`)
	if (opts?.user_location) parts.push(`location=${JSON.stringify(opts.user_location)}`)
	return parts.length ? parts.join(' ') : 'context=default'
}

function talkingPointsTools() {
	return [
		{
			type: 'file_search',
			vector_store_ids: resolvedArgumentsVectorStoreIds,
		},
		{
			type: 'web_search',
			search_context_size: ARGUMENTS_SEARCH_CONTEXT_SIZE,
			user_location: ARGUMENTS_USER_LOCATION,
		},
	]
}

function toResponsesTextFormat(responseFormat) {
	let format = responseFormat
	if (!format || typeof format !== 'object') return null
	if (format.type !== 'json_schema' || !format.json_schema || typeof format.json_schema !== 'object') return null
	let schema = format.json_schema
	let name = String(schema.name || '').trim()
	if (!name || !schema.schema || typeof schema.schema !== 'object') return null
	return {
		type: 'json_schema',
		name,
		schema: schema.schema,
		strict: schema.strict !== false,
	}
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

function parseFactsOutput(raw) {
	let parsed = extractJsonObjectFromText(raw)
	if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.facts)) return String(raw || '').trim()
	return parsed.facts
		.map(v => String(v || '').trim())
		.filter(Boolean)
		.join('\n')
}

function parseArgumentsOutput(raw) {
	let parsed = extractJsonObjectFromText(raw)
	if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.arguments)) return String(raw || '').trim()
	return parsed.arguments
		.map(v => String(v || '').trim())
		.filter(Boolean)
		.join('\n\n')
}

export function describeFactsSettings() {
	let temp = resolveWebSearchTemperatureConfig(factsModel, FACTS_TEMPERATURE)
	let tempLabel = temp.temperature === undefined ? 'unset' : String(temp.temperature)
	let reasoning = temp.reasoning ? 'reasoning.effort=none' : `reasoning.effort=${FACTS_REASONING_EFFORT}`
	let src = factsModelSource ? ` (${factsModelSource})` : ''
	return `api=responses tool=web_search model=${factsModel}${src} temp=${tempLabel} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

export function describeVideosSettings() {
	return describeVideoCollectionSettings()
}

export function describeTitleLookupSettings() {
	let temp = resolveWebSearchTemperatureConfig(titleLookupModel, TITLE_LOOKUP_TEMPERATURE)
	let tempLabel = temp.temperature === undefined ? 'unset' : String(temp.temperature)
	let reasoning = temp.reasoning ? 'reasoning.effort=none' : `reasoning.effort=${TITLE_LOOKUP_REASONING_EFFORT}`
	let src = titleLookupModelSource ? ` (${titleLookupModelSource})` : ''
	return `api=responses tool=web_search model=${titleLookupModel}${src} temp=${tempLabel} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

export function describeTalkingPointsSettings() {
	let src = argumentsModelSource ? ` (${argumentsModelSource})` : ''
	let vectorStoreInfo = `vector_stores=${resolvedArgumentsVectorStoreIds.join(',')}`
	return `api=responses tools=file_search,web_search model=${argumentsModel}${src} store=true reasoning.effort=${ARGUMENTS_REASONING_EFFORT} web_search_context=${ARGUMENTS_SEARCH_CONTEXT_SIZE} user_location=approximate ${vectorStoreInfo}`
}

export function describeAlternativeUrlLookupSettings() {
	let src = alternativeUrlModelSource ? ` (${alternativeUrlModelSource})` : ''
	return `api=responses tool=web_search model=${alternativeUrlModel}${src} parallel=${ALT_URL_PARALLEL_REQUESTS} reasoning.effort=${ALT_URL_REASONING_EFFORT} ${formatWebSearchOptions(webSearchOptions())}`
}

async function responseWithWebSearch({
	model,
	system,
	user,
	label,
	task,
	temperature,
	responseFormat,
	reasoningEffort,
	logger = log,
}) {
	let opts = webSearchOptions()
	try {
		let body = buildWebSearchWithTemperatureResponseBody({
			model,
			system,
			user,
			temperature,
			webSearchOptions: opts,
			responseFormat,
			reasoningEffort: reasoningEffort || (
				task === 'title_lookup'
					? TITLE_LOOKUP_REASONING_EFFORT
					: FACTS_REASONING_EFFORT
			),
		})
		let res = await openai.post('/responses', { body })
		estimateAndLogCost({
			task,
			model,
			usage: res?.usage,
			response: res,
			fallbackWebSearchCalls: 1,
			logger,
		})
		let content = extractResponseOutputText(res)
		if (content) return content.trim()
		logger(label, 'AI empty response')
		return
	} catch (e) {
		logger(label, 'AI failed\n', e)
		return
	}
}

async function responseWithTools({
	model,
	system,
	user,
	label,
	task,
	tools,
	reasoningEffort = 'low',
	responseFormat,
	store = false,
	logger = log,
}) {
	try {
		let body = {
			model,
			input: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			tools: Array.isArray(tools) ? tools : [],
			reasoning: { effort: reasoningEffort },
		}
		if (store) body.store = true
		let textFormat = toResponsesTextFormat(responseFormat)
		if (textFormat) body.text = { format: textFormat }
		let res = await openai.post('/responses', { body })
		estimateAndLogCost({
			task,
			model,
			usage: res?.usage,
			response: res,
			fallbackWebSearchCalls: Array.isArray(tools) && tools.some(t => t?.type === 'web_search') ? 1 : 0,
			logger,
		})
		let content = extractResponseOutputText(res)
		if (content) return content.trim()
		logger(label, 'AI empty response')
		return
	} catch (e) {
		logger(label, 'AI failed\n', e)
		return
	}
}

export async function collectFacts({ titleEn, titleRu, text, url }, { logger = log } = {}) {
	let prompt = await getPrompt(spreadsheetId, 'summarize:facts')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	let raw = await responseWithWebSearch({
		model: factsModel,
		system: prompt,
		user: input,
		label: 'FACTS',
		task: 'facts',
		temperature: FACTS_TEMPERATURE,
		responseFormat: FACTS_RESPONSE_FORMAT,
		logger,
	})
	return parseFactsOutput(raw)
}

export async function collectTalkingPoints({ titleEn, titleRu, text, url }, { logger = log } = {}) {
	let prompt = await getPrompt(spreadsheetId, 'summarize:arguments')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	let raw = await responseWithTools({
		model: argumentsModel,
		system: prompt,
		user: input,
		label: ARGUMENTS_LABEL,
		task: 'talking_points',
		tools: talkingPointsTools(),
		reasoningEffort: ARGUMENTS_REASONING_EFFORT,
		responseFormat: ARGUMENTS_RESPONSE_FORMAT,
		store: true,
		logger,
	})
	return parseArgumentsOutput(raw)
}

export async function collectVideos(
	{ titleEn, titleRu, articleTitle, text, html, url, usedUrl, alternativeUrls, source, date },
	{ logger = log } = {}
) {
	return await collectVideosFromTrustedSources({
		titleEn,
		titleRu,
		articleTitle,
		text,
		html,
		url,
		usedUrl,
		alternativeUrls,
		source,
		date,
	}, { logger })
}

function parseStructuredTitleLookup(raw) {
	let text = String(raw || '').trim()
	if (!text) return

	let candidate = text
	let fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	if (fence?.[1]) candidate = fence[1].trim()
	let objectMatch = candidate.match(/\{[\s\S]*\}/)
	if (objectMatch) candidate = objectMatch[0]

	try {
		let parsed = JSON.parse(candidate)
		if (!parsed || typeof parsed !== 'object') return
		return {
			titleEn: String(parsed.titleEn || parsed.title || '').trim(),
			titleRu: String(parsed.titleRu || '').trim(),
			extra: String(parsed.extra || parsed.context || parsed.summary || '').trim(),
		}
	} catch {
		return {
			titleEn: text,
			titleRu: '',
			extra: '',
		}
	}
}

function parseAlternativeUrlCandidates(raw) {
	let parsed = extractJsonObjectFromText(raw)
	let items = Array.isArray(parsed?.candidates) ? parsed.candidates : []
	let out = []
	for (let item of items) {
		let url = normalizeHttpUrl(item?.url)
		if (!url) continue
		out.push({
			url,
			source: String(item?.source || '').trim() || sourceFromUrl(url),
			title: String(item?.title || '').trim(),
			publishedAt: String(item?.publishedAt || '').trim(),
			reason: String(item?.reason || '').trim(),
		})
	}
	let seen = new Set()
	return out.filter(item => {
		if (seen.has(item.url)) return false
		seen.add(item.url)
		return true
	})
}

function buildAlternativeUrlSearchInputs({ url, titleEn, titleRu, source, keywords, strictKeywords, date }) {
	let title = String(titleRu || titleEn || '').trim()
	let originalUrl = normalizeHttpUrl(url)
	let originalHost = sourceFromUrl(originalUrl)
	let originalSource = String(source || '').trim()
	let keywordList = Array.isArray(keywords) ? keywords.map(v => String(v || '').trim()).filter(Boolean) : []
	let strictList = Array.isArray(strictKeywords) ? strictKeywords.map(v => String(v || '').trim()).filter(Boolean) : []
	let titleOrKeywords = title || keywordList.slice(0, 8).join(' ')

	return [
		{
			name: 'exact_title',
			user: [
				'Strategy hint: exact_title',
				`Original URL: ${originalUrl}`,
				`Original host: ${originalHost}`,
				`Original source name: ${originalSource}`,
				`Known title: ${title}`,
				`Search keywords: ${keywordList.join(', ')}`,
				`Strict keywords: ${strictList.join(', ')}`,
				`Story date: ${String(date || '').trim()}`,
			].join('\n'),
		},
		{
			name: 'strict_keywords',
			user: [
				'Strategy hint: strict_keywords',
				`Original URL: ${originalUrl}`,
				`Original host: ${originalHost}`,
				`Original source name: ${originalSource}`,
				`Known title: ${title}`,
				`Search keywords: ${keywordList.join(', ')}`,
				`Strict keywords: ${strictList.join(', ')}`,
				`Story date: ${String(date || '').trim()}`,
				`Search focus: ${strictList.slice(0, 6).join(' ') || titleOrKeywords}`,
			].join('\n'),
		},
		{
			name: 'url_context',
			user: [
				'Strategy hint: url_context',
				`Original URL: ${originalUrl}`,
				`Original host: ${originalHost}`,
				`Original source name: ${originalSource}`,
				`Known title: ${title}`,
				`Search keywords: ${keywordList.join(', ')}`,
				`Strict keywords: ${strictList.join(', ')}`,
				`Story date: ${String(date || '').trim()}`,
				`Search focus: ${titleOrKeywords}`,
			].join('\n'),
		},
	].filter(item => String(item.user || '').trim())
}

export async function collectTitleByUrl({ url }, { logger = log } = {}) {
	let prompt = await getPrompt(spreadsheetId, 'summarize:title-by-url')
	let input = `URL: ${url}`
	let raw = await responseWithWebSearch({
		model: titleLookupModel,
		system: prompt,
		user: input,
		label: 'TITLE_BY_URL',
		task: 'title_lookup',
		temperature: TITLE_LOOKUP_TEMPERATURE,
		responseFormat: TITLE_LOOKUP_RESPONSE_FORMAT,
		logger,
	})
	return parseStructuredTitleLookup(raw)
}

export async function collectAlternativeUrlsByStory(
	{ url, titleEn, titleRu, source, keywords, strictKeywords, date },
	{ logger = log } = {}
) {
	let originalUrl = normalizeHttpUrl(url)
	if (!originalUrl) return []

	let prompt = await getPrompt(spreadsheetId, 'summarize:alternative-url-search')
	let inputs = buildAlternativeUrlSearchInputs({
		url: originalUrl,
		titleEn,
		titleRu,
		source,
		keywords,
		strictKeywords,
		date,
	}).slice(0, ALT_URL_PARALLEL_REQUESTS)

	if (!inputs.length) return []

	let results = await Promise.allSettled(inputs.map(async item => {
		let raw = await responseWithWebSearch({
			model: alternativeUrlModel,
			system: prompt,
			user: item.user,
			label: `ALT_URL_${item.name}`,
			task: 'alternative_url_lookup',
			responseFormat: ALT_URL_RESPONSE_FORMAT,
			reasoningEffort: ALT_URL_REASONING_EFFORT,
			logger,
		})
		let candidates = parseAlternativeUrlCandidates(raw)
		logger('ALT_URL_LOOKUP', `strategy=${item.name}`, `candidates=${candidates.length}`)
		return candidates.map(candidate => ({ ...candidate, strategy: item.name }))
	}))

	let seen = new Set()
	let out = []
	for (let result of results) {
		if (result.status !== 'fulfilled') continue
		for (let candidate of result.value || []) {
			let url = normalizeHttpUrl(candidate?.url)
			if (!url || url === originalUrl || seen.has(url)) continue
			seen.add(url)
			out.push({
				url,
				source: String(candidate?.source || '').trim() || sourceFromUrl(url),
				title: String(candidate?.title || '').trim(),
				publishedAt: String(candidate?.publishedAt || '').trim(),
				reason: String(candidate?.reason || '').trim(),
				strategy: String(candidate?.strategy || '').trim(),
			})
		}
	}
	return out
}
