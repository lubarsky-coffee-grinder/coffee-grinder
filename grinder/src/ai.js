import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { getPrompt } from './prompts.js'
import { estimateAndLogCost } from './cost.js'

const openai = new OpenAI()

const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
const FALLBACK_OPENAI_MODEL = 'gpt-4o-mini'
const SUMMARIZE_TEMPERATURE = 0

const explicitModel = process.env.OPENAI_SUMMARIZE_MODEL || process.env.OPENAI_MODEL
const modelSource = process.env.OPENAI_SUMMARIZE_MODEL
	? 'OPENAI_SUMMARIZE_MODEL'
	: process.env.OPENAI_MODEL
		? 'OPENAI_MODEL'
		: 'default'

let model = explicitModel || DEFAULT_OPENAI_MODEL
let summaryTemperature = temperatureForModel(model)

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

function temperatureForModel(nextModel) {
	if ((nextModel || '').toLowerCase().startsWith('gpt-5')) return undefined
	return SUMMARIZE_TEMPERATURE
}

function describeSummarizeSettings(currentModel) {
	let src = modelSource ? ` (${modelSource})` : ''
	let tempLabel = summaryTemperature === undefined ? 'unset' : String(summaryTemperature)
	return `api=chat.completions model=${currentModel}${src} temperature=${tempLabel} response_format=json_schema reasoning=unset`
}

function isUnsupportedModel(e) {
	return e?.code === 'unsupported_model' || e?.error?.code === 'unsupported_model'
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

function isTemperatureUnsupported(e) {
	const code = e?.code
	const nested = e?.error?.code
	const message = `${e?.message || ''} ${e?.error?.message || ''}`.toLowerCase()
	return code === 'unsupported_value' || nested === 'unsupported_value' || message.includes('temperature')
}

let instructions = ''
let init = (async () => {
	instructions = await getPrompt(spreadsheetId, 'summarize:summary')
	log('AI summarize:', describeSummarizeSettings(model))
})()

async function chatSummarize({ url, text, logger = log }) {
	let content = `URL: ${url}\nText:\n${text}`
	const request = {
		model,
		response_format: RESPONSE_FORMAT,
		messages: [
			{ role: 'system', content: instructions },
			{ role: 'user', content },
		],
	}
	if (summaryTemperature !== undefined) request.temperature = summaryTemperature

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

export async function ai({ url, text, logger = log }) {
	await init

	let retriedTransient = false
	for (;;) {
		try {
			let res = await chatSummarize({ url, text, logger })
			if (res) return res
			logger('AI summarize: empty result')
			return null
		} catch (e) {
			if (isTemperatureUnsupported(e) && summaryTemperature !== undefined) {
				summaryTemperature = undefined
				logger('AI summarize: temperature unsupported, retrying without temperature', '\n', e)
				logger('AI summarize:', describeSummarizeSettings(model))
				continue
			}

			if (isModelNotFound(e) && !explicitModel && model !== FALLBACK_OPENAI_MODEL) {
				logger('AI model not found:', model, '\nFalling back to:', FALLBACK_OPENAI_MODEL, '\n', e)
				model = FALLBACK_OPENAI_MODEL
				summaryTemperature = temperatureForModel(model)
				logger('AI summarize:', describeSummarizeSettings(model))
				continue
			}

			if (isTransientApiError(e) && !retriedTransient) {
				retriedTransient = true
				logger('AI summarize: transient error, retrying once', '\n', e)
				await sleep(1500)
				continue
			}

			if (isUnsupportedModel(e)) {
				logger('AI summarize: unsupported model\n', e)
				return null
			}

			logger('AI fail\n', e)
			return null
		}
	}
}
