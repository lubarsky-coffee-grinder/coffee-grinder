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

async function responseWithWebSearch({ model, system, user, label, task, temperature, logger = log }) {
	let opts = webSearchOptions()
	try {
		let body = buildWebSearchWithTemperatureResponseBody({
			model,
			system,
			user,
			temperature,
			webSearchOptions: opts,
			reasoningEffort: task === 'title_lookup'
				? TITLE_LOOKUP_REASONING_EFFORT
				: FACTS_REASONING_EFFORT,
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

export async function collectFacts({ titleEn, titleRu, text, url }, { logger = log } = {}) {
	let prompt = await getPrompt(spreadsheetId, 'summarize:facts')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	return await responseWithWebSearch({
		model: factsModel,
		system: prompt,
		user: input,
		label: 'FACTS',
		task: 'facts',
		temperature: FACTS_TEMPERATURE,
		logger,
	})
}

export async function collectVideos(
	{ titleEn, titleRu, text, url, usedUrl, alternativeUrls, source, date },
	{ logger = log } = {}
) {
	return await collectVideosFromTrustedSources({
		titleEn,
		titleRu,
		text,
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
		logger,
	})
	return parseStructuredTitleLookup(raw)
}
