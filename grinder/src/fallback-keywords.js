import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { getPrompt } from './prompts.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { estimateAndLogCost } from './cost.js'

const openai = new OpenAI()

const DEFAULT_MODEL = 'gpt-4.1-mini'
const FALLBACK_MODEL = 'gpt-4.1'

const explicitModel = process.env.OPENAI_FALLBACK_KEYWORDS_MODEL
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
	return `api=chat.completions model=${model}${src} temperature=0 response_format=json_schema`
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

	let models = !explicitModel && model !== FALLBACK_MODEL
		? [model, FALLBACK_MODEL]
		: [model]

	for (let m of models) {
		let retriedTransient = false
		for (;;) {
			try {
				let res = await openai.chat.completions.create({
					model: m,
					temperature: 0,
					response_format: RESPONSE_FORMAT,
					messages: [
						{ role: 'system', content: prompt },
						{ role: 'user', content: user },
					],
				})
				estimateAndLogCost({
					task: 'fallback_keywords',
					model: m,
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
				if (isModelNotFound(e) && !explicitModel && m !== FALLBACK_MODEL) {
					logger('FALLBACK_KEYWORDS model not available:', m, 'falling back to:', FALLBACK_MODEL)
					break
				}
				if (isTransientApiError(e) && !retriedTransient) {
					retriedTransient = true
					logger('FALLBACK_KEYWORDS transient error, retrying once\n', e)
					await sleep(1500)
					continue
				}
				logger('FALLBACK_KEYWORDS AI failed\n', e)
				return []
			}
		}
	}
	return []
}
