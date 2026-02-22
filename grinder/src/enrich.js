import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { getPrompt } from './prompts.js'
import { estimateAndLogCost } from './cost.js'
import { collectVideosFromTrustedSources, describeVideoCollectionSettings } from './video-links.js'
import {
	assertWebSearchWithTemperatureModel,
	buildWebSearchWithTemperatureResponseBody,
	extractResponseOutputText,
	normalizeWebSearchWithTemperatureModel,
} from './openai-websearch-templates.js'

const openai = new OpenAI()

const DEFAULT_WEBSEARCH_MODEL = 'gpt-5.2'
const FALLBACK_WEBSEARCH_MODEL = 'gpt-4.1'

const FACTS_TEMPERATURE = 0.2
const TITLE_LOOKUP_TEMPERATURE = 0.2

const explicitWebsearchModel = process.env.OPENAI_WEBSEARCH_MODEL
const explicitFactsModel = process.env.OPENAI_FACTS_MODEL || explicitWebsearchModel

const factsModel = explicitFactsModel || DEFAULT_WEBSEARCH_MODEL
const factsModelSource = process.env.OPENAI_FACTS_MODEL
	? 'OPENAI_FACTS_MODEL'
	: process.env.OPENAI_WEBSEARCH_MODEL
		? 'OPENAI_WEBSEARCH_MODEL'
		: ''

function webSearchOptions() {
	let search_context_size = process.env.OPENAI_WEBSEARCH_CONTEXT_SIZE
	let country = process.env.OPENAI_WEBSEARCH_COUNTRY
	let city = process.env.OPENAI_WEBSEARCH_CITY
	let region = process.env.OPENAI_WEBSEARCH_REGION
	let timezone = process.env.OPENAI_WEBSEARCH_TIMEZONE

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

function isModelNotFound(e) {
	return e?.code === 'model_not_found' || e?.status === 404
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

function formatWebSearchOptions(opts) {
	let parts = []
	if (opts?.search_context_size) parts.push(`context=${opts.search_context_size}`)
	if (opts?.user_location) parts.push(`location=${JSON.stringify(opts.user_location)}`)
	return parts.length ? parts.join(' ') : 'context=default'
}

export function describeFactsSettings() {
	let family = normalizeWebSearchWithTemperatureModel(factsModel)
	let reasoning = family === 'gpt-5.2' ? 'reasoning.effort=none' : 'reasoning=unset'
	let src = factsModelSource ? ` (${factsModelSource})` : ''
	return `api=responses tool=web_search model=${factsModel}${src} temp=${FACTS_TEMPERATURE} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

export function describeVideosSettings() {
	return describeVideoCollectionSettings()
}

export function describeTitleLookupSettings() {
	let family = normalizeWebSearchWithTemperatureModel(factsModel)
	let reasoning = family === 'gpt-5.2' ? 'reasoning.effort=none' : 'reasoning=unset'
	let src = factsModelSource ? ` (${factsModelSource})` : ''
	return `api=responses tool=web_search model=${factsModel}${src} temp=${TITLE_LOOKUP_TEMPERATURE} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

async function responseWithWebSearch({ model, allowFallback, system, user, label, task, temperature, logger = log }) {
	let opts = webSearchOptions()
	let models = allowFallback && model !== FALLBACK_WEBSEARCH_MODEL
		? [model, FALLBACK_WEBSEARCH_MODEL]
		: [model]

	for (let m of models) {
		assertWebSearchWithTemperatureModel(m)
		let retriedTransient = false
		for (;;) {
			try {
				let body = buildWebSearchWithTemperatureResponseBody({
					model: m,
					system,
					user,
					temperature,
					webSearchOptions: opts,
				})
				let res = await openai.post('/responses', { body })
				estimateAndLogCost({
					task,
					model: m,
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
				if (isModelNotFound(e) && allowFallback && m !== FALLBACK_WEBSEARCH_MODEL) {
					logger(label, 'Model not available:', m, 'falling back to:', FALLBACK_WEBSEARCH_MODEL)
					break
				}

				if (e?.status === 400) {
					logger(label, 'AI bad request\n', e)
					return
				}

				if (isTransientApiError(e) && !retriedTransient) {
					retriedTransient = true
					logger(label, 'AI transient error, retrying once\n', e)
					await sleep(1500)
					continue
				}

				logger(label, 'AI failed\n', e)
				return
			}
		}
	}
}

export async function collectFacts({ titleEn, titleRu, text, url }, { logger = log } = {}) {
	assertWebSearchWithTemperatureModel(factsModel, factsModelSource)
	let prompt = await getPrompt(spreadsheetId, 'summarize:facts')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	return await responseWithWebSearch({
		model: factsModel,
		allowFallback: !explicitFactsModel,
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
	assertWebSearchWithTemperatureModel(factsModel, factsModelSource)
	let prompt = await getPrompt(spreadsheetId, 'summarize:title-by-url')
	let input = `URL: ${url}`
	let raw = await responseWithWebSearch({
		model: factsModel,
		allowFallback: !explicitFactsModel,
		system: prompt,
		user: input,
		label: 'TITLE_BY_URL',
		task: 'title_lookup',
		temperature: TITLE_LOOKUP_TEMPERATURE,
		logger,
	})
	return parseStructuredTitleLookup(raw)
}
