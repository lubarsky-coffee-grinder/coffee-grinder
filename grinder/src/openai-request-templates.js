import {
	resolveChatCompletionsTemperature,
	resolveReasoningEffort,
	resolveResponsesTemperatureConfig,
} from './openai-model-params.js'

const DETERMINISTIC_HINT = [
	'Style guardrail:',
	'prefer deterministic factual output for newsroom use.',
	'Avoid creative variation, speculation, and unstable phrasing.',
].join(' ')

const TEMP_UNSUPPORTED_HINT = [
	'Model parameter note:',
	'temperature is unavailable for this model in this endpoint.',
].join(' ')

function appendHint(system, hint) {
	let base = String(system || '').trim()
	if (!hint) return base
	if (!base) return hint
	if (base.includes(hint)) return base
	return `${base}\n\n${hint}`
}

function withSamplingHint(system, requestedTemperature, actualTemperature) {
	let out = String(system || '').trim()
	if (requestedTemperature !== undefined) {
		out = appendHint(out, DETERMINISTIC_HINT)
	}
	if (requestedTemperature !== undefined && actualTemperature === undefined) {
		out = appendHint(out, TEMP_UNSUPPORTED_HINT)
	}
	return out
}

function buildWebSearchTool(opts) {
	let tool = { type: 'web_search' }
	if (opts && typeof opts === 'object') {
		if (opts.search_context_size) tool.search_context_size = opts.search_context_size
		if (opts.user_location) tool.user_location = opts.user_location
	}
	return tool
}

function toResponsesTextFormat(responseFormat) {
	let format = responseFormat
	if (!format || typeof format !== 'object') return null

	if (format.type === 'json_schema' && format.json_schema && typeof format.json_schema === 'object') {
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
	return null
}

export function buildResponsesWebSearchRequest({
	model,
	system,
	user,
	temperature,
	webSearchOptions,
	responseFormat,
	reasoningEffort = 'low',
}) {
	let tempConfig = resolveResponsesTemperatureConfig(model, temperature)
	let systemWithHint = withSamplingHint(system, temperature, tempConfig.temperature)
	let request = {
		model,
		input: [
			{ role: 'system', content: systemWithHint },
			{ role: 'user', content: user },
		],
		tools: [buildWebSearchTool(webSearchOptions)],
	}

	if (tempConfig.temperature !== undefined) request.temperature = tempConfig.temperature

	let reasoning = tempConfig.reasoning
	if (!reasoning) {
		let effort = resolveReasoningEffort(model, reasoningEffort)
		if (effort) reasoning = { effort }
	}
	if (reasoning) request.reasoning = reasoning

	let textFormat = toResponsesTextFormat(responseFormat)
	if (textFormat) {
		request.text = { format: textFormat }
	}

	return {
		request,
		temperature: tempConfig.temperature,
		reasoning: reasoning?.effort || 'unset',
	}
}

export function buildChatCompletionsRequest({
	model,
	system,
	user,
	messages,
	temperature,
	reasoningEffort = 'low',
	responseFormat,
	maxTokens,
}) {
	let temp = resolveChatCompletionsTemperature(model, temperature)

	let builtMessages
	if (Array.isArray(messages) && messages.length) {
		builtMessages = messages.map(m => ({ ...m }))
		let firstSystem = builtMessages.find(m => m?.role === 'system' && typeof m?.content === 'string')
		if (firstSystem) {
			firstSystem.content = withSamplingHint(firstSystem.content, temperature, temp)
		}
	} else {
		let systemWithHint = withSamplingHint(system, temperature, temp)
		builtMessages = [
			{ role: 'system', content: systemWithHint },
			{ role: 'user', content: user },
		]
	}

	let request = {
		model,
		messages: builtMessages,
	}
	if (responseFormat) request.response_format = responseFormat
	if (maxTokens !== undefined) request.max_tokens = maxTokens
	if (temp !== undefined) request.temperature = temp

	let effort = resolveReasoningEffort(model, reasoningEffort)
	if (effort) request.reasoning_effort = effort

	return {
		request,
		temperature: temp,
		reasoning: effort || 'unset',
	}
}
