import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { getPrompt } from './prompts.js'
import { log } from './log.js'
import { readEnv } from './env.js'
import { estimateAndLogCost } from './cost.js'
import { buildChatCompletionsRequest } from './openai-request-templates.js'

const openai = new OpenAI()

const DEFAULT_MODEL = 'gpt-4.1-mini'
const KEYWORDS_REASONING_EFFORT = 'medium'

const explicitModel = readEnv('OPENAI_FALLBACK_KEYWORDS_MODEL')
const model = explicitModel || DEFAULT_MODEL
const modelSource = explicitModel ? 'OPENAI_FALLBACK_KEYWORDS_MODEL' : ''

const RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'fallback_url_keywords',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				keywords: {
					type: 'array',
					items: { type: 'string' },
					minItems: 0,
					maxItems: 12,
				},
			},
			required: ['keywords'],
		},
		strict: true,
	},
}

function uniq(list) {
	let seen = new Set()
	let out = []
	for (let v of list || []) {
		v = String(v ?? '').trim().toLowerCase()
		if (!v) continue
		if (seen.has(v)) continue
		seen.add(v)
		out.push(v)
	}
	return out
}

function normalizeKeywords(list, allowed) {
	let keywords = uniq(Array.isArray(list) ? list : [])
	if (allowed && allowed.size) {
		keywords = keywords.filter(k => allowed.has(k))
	}
	return keywords
}

export function describeFallbackKeywordsSettings() {
	let src = modelSource ? ` (${modelSource})` : ''
	let built = buildChatCompletionsRequest({
		model,
		system: '',
		user: '',
		temperature: 0,
		reasoningEffort: KEYWORDS_REASONING_EFFORT,
	})
	let tempLabel = built.temperature === undefined ? 'unset' : String(built.temperature)
	return `api=chat.completions model=${model}${src} temperature=${tempLabel} response_format=json_schema reasoning=${built.reasoning}`
}

export async function extractFallbackKeywords(url, manualKeywords, limit = 8, { logger = log } = {}) {
	let allowed = new Set(uniq(manualKeywords))
	if (!url || allowed.size === 0) return []

	let prompt = await getPrompt(spreadsheetId, 'summarize:fallback-keywords')
	let candidates = Array.from(allowed)

	let user = [
		`URL: ${url}`,
		`Candidate tokens (${candidates.length}): ${candidates.join(', ')}`,
		`Max keywords: ${limit}`,
	].join('\n')

	try {
		let built = buildChatCompletionsRequest({
			model,
			system: prompt,
			user,
			responseFormat: RESPONSE_FORMAT,
			temperature: 0,
			reasoningEffort: KEYWORDS_REASONING_EFFORT,
		})
		let res = await openai.chat.completions.create(built.request)
		estimateAndLogCost({
			task: 'fallback_keywords',
			model,
			usage: res?.usage,
			logger,
		})
		let content = res?.choices?.[0]?.message?.content
		if (!content) return []

		let parsed
		try { parsed = JSON.parse(content) } catch { return [] }
		let keywords = normalizeKeywords(parsed?.keywords, allowed).slice(0, limit)
		return keywords
	} catch (e) {
		logger('FALLBACK_KEYWORDS AI failed\n', e)
		return []
	}
}
