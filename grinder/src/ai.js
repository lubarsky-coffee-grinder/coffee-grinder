import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { readEnv } from './env.js'
import { getPrompt } from './prompts.js'
import { estimateAndLogCost } from './cost.js'
import { buildChatCompletionsRequest } from './openai-request-templates.js'

const openai = new OpenAI()

const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
const SUMMARIZE_TEMPERATURE = 0
const SUMMARIZE_REASONING_EFFORT = 'medium'
const SUMMARY_SOURCE_GUARDRAIL = 'ВАЖНО!!! НИКОГДА НЕ ДОБАВЛЯЙ ИСТОЧНИК В SUMMARY И НЕ ПИШИ ФРАЗЫ ТИПА "ПО ДАННЫМ ...". МЫ ДОБАВЛЯЕМ ИСТОЧНИК САМИ В ПАЙПЛАЙНЕ!!!'

const explicitModel = readEnv('OPENAI_SUMMARIZE_MODEL')
const modelSource = explicitModel ? 'OPENAI_SUMMARIZE_MODEL' : 'default'
const model = explicitModel || DEFAULT_OPENAI_MODEL

const RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'article_summary',
		schema: {
			type: 'object',
			additionalProperties: false,
				properties: {
					titleRu: { type: 'string' },
					summary: { type: 'string' },
					topic: { type: 'string' },
					priority: { type: 'integer', minimum: 1, maximum: 5 },
				},
				required: ['titleRu', 'summary', 'topic', 'priority'],
			},
			strict: true,
		},
	}

function describeSummarizeSettings(currentModel) {
	let src = modelSource ? ` (${modelSource})` : ''
	let built = buildChatCompletionsRequest({
		model: currentModel,
		system: '',
		user: '',
		temperature: SUMMARIZE_TEMPERATURE,
		reasoningEffort: SUMMARIZE_REASONING_EFFORT,
	})
	let tempLabel = built.temperature === undefined ? 'unset' : String(built.temperature)
	return `api=chat.completions model=${currentModel}${src} temperature=${tempLabel} response_format=json_schema reasoning=${built.reasoning}`
}

function isUnsupportedModel(e) {
	return e?.code === 'unsupported_model' || e?.error?.code === 'unsupported_model'
}

let instructions = ''
let init = (async () => {
	instructions = await getPrompt(spreadsheetId, 'summarize:summary')
	log('AI summarize:', describeSummarizeSettings(model))
})()

function withSummaryGuardrail(systemPrompt) {
	let base = String(systemPrompt || '').trim()
	if (!base) return SUMMARY_SOURCE_GUARDRAIL
	if (base.includes(SUMMARY_SOURCE_GUARDRAIL)) return base
	return `${base}\n\n${SUMMARY_SOURCE_GUARDRAIL}`
}

async function chatSummarize({ url, text, agency, logger = log }) {
	let content = [
		`URL: ${url}`,
		`Source: ${String(agency || '').trim()}`,
		`Text:\n${text}`,
	].join('\n')
	let built = buildChatCompletionsRequest({
		model,
		system: withSummaryGuardrail(instructions),
		user: content,
		responseFormat: RESPONSE_FORMAT,
		temperature: SUMMARIZE_TEMPERATURE,
		reasoningEffort: SUMMARIZE_REASONING_EFFORT,
	})
	const request = built.request

	let res = await openai.chat.completions.create(request)
	estimateAndLogCost({
		task: 'summary',
		model,
		usage: res?.usage,
		logger,
	})

	let msg = res?.choices?.[0]?.message?.content
	if (!msg) return null

	let parsed
	try {
		parsed = JSON.parse(msg)
	} catch (e) {
		logger('AI fail\n', msg, '\n', e)
		return null
	}

	let used = res?.usage?.total_tokens
	if (Number.isFinite(used)) {
		logger('got', String(parsed?.summary || '').length, 'chars,', used, 'tokens used')
		parsed.delay = used / 30e3 * 60e3
	} else {
		logger('got', String(parsed?.summary || '').length, 'chars')
		parsed.delay = 0
	}
	return parsed
}

export async function ai({ url, text, agency, logger = log }) {
	await init

	try {
		let res = await chatSummarize({ url, text, agency, logger })
		if (res) return res
		logger('AI summarize: empty result')
		return null
	} catch (e) {
		if (isUnsupportedModel(e)) {
			logger('AI summarize: unsupported model\n', e)
			return null
		}

		logger('AI fail\n', e)
		return null
	}
}
