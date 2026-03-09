import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

let openaiPostCalls = []
mock.module('openai', {
	defaultExport: class OpenAI {
		async post(_path, payload) {
			openaiPostCalls.push(payload)
			return {
				outputText: JSON.stringify({
					facts: [
						{
							fact: 'Джек Шлоссберг родился девятнадцатого января тысяча девятьсот девяносто третьего года.',
							sourceUrl: 'https://www.britannica.com/biography/Jack-Schlossberg',
						},
						{
							fact: 'Надлер представляет округ в Палате представителей с тысяча девятьсот девяносто второго года.',
							sourceUrl: 'https://www.congress.gov/member/jerrold-nadler/N000002',
						},
					],
				}),
				usage: {},
			}
		}
	},
})

mock.module(mod('store.js'), {
	namedExports: {
		spreadsheetId: 'sheet-test',
	}
})

mock.module(mod('prompts.js'), {
	namedExports: {
		getPrompt: async () => 'Legacy prompt that still says bullet list.',
	}
})

mock.module(mod('cost.js'), {
	namedExports: {
		estimateAndLogCost: () => {},
	}
})

mock.module(mod('video-links.js'), {
	namedExports: {
		collectVideosFromTrustedSources: async () => '',
		describeVideoCollectionSettings: () => 'videos=mock',
	}
})

mock.module(mod('env.js'), {
	namedExports: {
		readEnv: () => '',
	}
})

mock.module(mod('openai-websearch-templates.js'), {
	namedExports: {
		buildWebSearchWithTemperatureResponseBody: ({
			model,
			system,
			user,
			temperature,
			webSearchOptions,
			responseFormat,
			reasoningEffort,
		}) => ({
			model,
			system,
			user,
			temperature,
			webSearchOptions,
			responseFormat,
			reasoningEffort,
		}),
		extractResponseOutputText: response => response?.outputText || '',
		resolveWebSearchTemperatureConfig: () => ({ reasoning: true }),
	}
})

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

const { collectFacts } = await import(mod('enrich.js'))

test('collectFacts requests structured fact/source JSON and stores only fact text', async () => {
	openaiPostCalls = []

	let result = await collectFacts({
		titleEn: 'Jack Schlossberg ramps up name-dropping of grandpa JFK',
		titleRu: '',
		text: 'Story text about Jack Schlossberg and a campaign-style fundraising effort.',
		url: 'https://example.com/story',
	})

	assert.equal(
		result,
		[
			'Джек Шлоссберг родился девятнадцатого января тысяча девятьсот девяносто третьего года.',
			'Надлер представляет округ в Палате представителей с тысяча девятьсот девяносто второго года.',
		].join('\n')
	)

	assert.equal(openaiPostCalls.length, 1)
	let payload = openaiPostCalls[0]?.body || {}
	let factsSchema = payload?.responseFormat?.json_schema?.schema?.properties?.facts?.items
	assert.equal(factsSchema?.properties?.fact?.type, 'string')
	assert.equal(factsSchema?.properties?.sourceUrl?.type, 'string')
	assert.match(String(payload?.system || ''), /sourceUrl/i)
	assert.match(String(payload?.system || ''), /RETURN ONLY JSON MATCHING THE SUPPLIED SCHEMA/i)
})
