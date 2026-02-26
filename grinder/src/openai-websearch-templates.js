import { resolveResponsesTemperatureConfig } from './openai-model-params.js'
import { buildResponsesWebSearchRequest } from './openai-request-templates.js'

export function resolveWebSearchTemperatureConfig(model, temperature) {
	return resolveResponsesTemperatureConfig(model, temperature)
}

export function buildWebSearchWithTemperatureResponseBody({
	model,
	system,
	user,
	temperature,
	webSearchOptions,
	reasoningEffort = 'low',
}) {
	let built = buildResponsesWebSearchRequest({
		model,
		system,
		user,
		temperature,
		webSearchOptions,
		reasoningEffort,
	})
	return built.request
}

export function extractResponseOutputText(res) {
	if (!res) return ''
	if (typeof res.output_text === 'string' && res.output_text.trim()) return res.output_text.trim()

	// Fallback to raw Responses shape: output[].content[].text.
	let out = []
	let output = Array.isArray(res.output) ? res.output : []
	for (let item of output) {
		if (!item || typeof item !== 'object') continue
		if (item.type !== 'message') continue
		let content = Array.isArray(item.content) ? item.content : []
		for (let c of content) {
			if (!c || typeof c !== 'object') continue

			// Most common: { type: 'output_text', text: '...' }
			if (typeof c.text === 'string' && c.text.trim()) {
				out.push(c.text.trim())
				continue
			}

			// Some SDK shapes: { type: 'output_text', text: { value: '...' } }
			if (c.text && typeof c.text === 'object') {
				let v = c.text.value
				if (typeof v === 'string' && v.trim()) out.push(v.trim())
			}
		}
	}
	return out.join('\n').trim()
}
