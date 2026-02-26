import assert from 'node:assert/strict'
import test from 'node:test'

import {
	buildWebSearchWithTemperatureResponseBody,
	extractResponseOutputText,
	resolveWebSearchTemperatureConfig,
} from '../src/openai-websearch-templates.js'
import {
	resolveReasoningEffort,
	resolveChatCompletionsTemperature,
	resolveResponsesTemperatureConfig,
} from '../src/openai-model-params.js'
import { buildChatCompletionsRequest } from '../src/openai-request-templates.js'

test('responses template applies model-aware temperature handling', () => {
	let body = buildWebSearchWithTemperatureResponseBody({
		model: 'gpt-5-mini',
		system: 'sys',
		user: 'user',
		temperature: 0.2,
		webSearchOptions: { search_context_size: 'low' },
	})
	assert.equal(body.temperature, undefined)
	assert.equal(body.reasoning?.effort, 'low')
	assert.equal(body.input?.[0]?.role, 'system')
	assert.ok(String(body.input?.[0]?.content || '').includes('temperature is unavailable'))
})

test('gpt-5.2 template forces reasoning.effort=none to keep temperature compatible', () => {
	let body = buildWebSearchWithTemperatureResponseBody({
		model: 'gpt-5.2',
		system: 'sys',
		user: 'user',
		temperature: 0.2,
		webSearchOptions: { search_context_size: 'low' },
	})
	assert.deepEqual(body.reasoning, { effort: 'none' })
	assert.equal(body.temperature, 0.2)
	assert.equal(body.tools?.[0]?.type, 'web_search')
})

test('temperature configs are model-aware for responses and chat.completions', () => {
	let responses = resolveResponsesTemperatureConfig('gpt-5-mini', 0.2)
	assert.equal(responses.mode, 'unsupported')
	assert.equal(responses.temperature, undefined)
	assert.equal(responses.reasoning, undefined)

	let responsesWithReasoning = resolveWebSearchTemperatureConfig('gpt-5.2', 0.2)
	assert.equal(responsesWithReasoning.mode, 'reasoning_none')
	assert.equal(responsesWithReasoning.temperature, 0.2)
	assert.deepEqual(responsesWithReasoning.reasoning, { effort: 'none' })

	assert.equal(resolveChatCompletionsTemperature('gpt-5-mini', 0), undefined)
	assert.equal(resolveChatCompletionsTemperature('gpt-4.1-mini', 0), 0)
	assert.equal(resolveReasoningEffort('gpt-5-mini', 'low'), 'low')
	assert.equal(resolveReasoningEffort('gpt-4.1-mini', 'low'), undefined)
})

test('chat template applies sampling hint and reasoning_effort automatically', () => {
	let built = buildChatCompletionsRequest({
		model: 'gpt-5-mini',
		system: 'sys',
		user: 'usr',
		temperature: 0,
		responseFormat: { type: 'json_object' },
		reasoningEffort: 'low',
	})
	assert.equal(built.request.temperature, undefined)
	assert.equal(built.request.reasoning_effort, 'low')
	assert.ok(String(built.request.messages?.[0]?.content || '').includes('temperature is unavailable'))
})

test('extractResponseOutputText parses raw Responses shape', () => {
	let text = extractResponseOutputText({
		output: [
			{
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'output_text', text: 'hello' },
					{ type: 'output_text', text: { value: 'world' } },
				],
			},
		],
	})
	assert.equal(text, 'hello\nworld')
})
