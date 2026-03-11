import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

process.env.VIDEO_GPT_VERIFY = '0'
process.env.VIDEO_GPT_WEBSEARCH = '0'
process.env.YOUTUBE_API_ENABLED = '0'
delete process.env.OPENAI_API_KEY
delete process.env.SERPAPI_KEY

let openaiPostImpl = async () => ({ outputText: '', usage: {} })
mock.module('openai', {
	defaultExport: class OpenAI {
		async post(path, payload) {
			return await openaiPostImpl(path, payload)
		}
	},
})

mock.module('google-auth-library', {
	namedExports: {
		OAuth2Client: class OAuth2Client {
			setCredentials() {}
		},
	}
})

let newsApiCalls = 0
mock.module(mod('newsapi.js'), {
	namedExports: {
		findAlternativeArticles: async () => {
			newsApiCalls++
			return []
		},
	}
})

mock.module(mod('env.js'), {
	namedExports: {
		readEnv: (name) => process.env[name] || '',
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

mock.module(mod('store.js'), {
	namedExports: {
		spreadsheetId: 'sheet-test',
	}
})

mock.module(mod('prompts.js'), {
	namedExports: {
		getPrompt: async () => '',
	}
})

mock.module(mod('cost.js'), {
	namedExports: {
		estimateAndLogCost: () => {},
		trackApiRequest: () => {},
		trackApiResult: () => {},
	}
})

mock.module(mod('openai-request-templates.js'), {
	namedExports: {
		buildChatCompletionsRequest: ({ messages }) => ({ request: { messages } }),
		buildResponsesWebSearchRequest: ({ model, system, user, temperature, webSearchOptions, responseFormat, reasoningEffort }) => ({
			request: {
				model,
				system,
				user,
				temperature,
				webSearchOptions,
				responseFormat,
				reasoningEffort,
			},
		}),
	}
})

mock.module(mod('openai-websearch-templates.js'), {
	namedExports: {
		extractResponseOutputText: (response) => response?.outputText || '',
	}
})

const fetchCalls = []
let fetchImpl = async (url) => {
	throw new Error(`Unexpected fetch: ${url}`)
}
globalThis.fetch = async (input) => {
	let url = String(input)
	fetchCalls.push(url)
	return await fetchImpl(url)
}

const { collectVideosFromTrustedSources } = await import(mod('video-links.js'))

test('collectVideosFromTrustedSources uses exact article html youtube embed before external fallbacks', async () => {
	fetchCalls.length = 0
	fetchImpl = async (url) => {
		if (url.startsWith('https://www.youtube.com/oembed')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					title: 'Publisher YouTube Clip',
					author_name: 'Reuters',
				}),
			}
		}
		if (url.startsWith('https://www.youtube.com/watch')) {
			return {
				ok: true,
				status: 200,
				text: async () => `
					<meta property="og:title" content="Publisher YouTube Clip">
					<meta property="og:description" content="Story clip from publisher channel">
					<script>var ytInitialPlayerResponse={"playabilityStatus":{"status":"OK"}};</script>
				`,
			}
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}

	let logs = []
	let result = await collectVideosFromTrustedSources({
		titleEn: 'McDonalds CEO viral moment',
		text: 'McDonalds CEO viral moment article text with enough context for video matching.',
		url: 'https://example.com/story',
		usedUrl: 'https://example.com/story',
		source: 'Reuters',
		date: '2026-03-06T20:54:02.000Z',
		html: `
			<article>
				<h1>Story</h1>
				<iframe src="https://www.youtube.com/embed/abc123DEF45"></iframe>
			</article>
		`,
	}, {
		logger: (...args) => logs.push(args.join(' ')),
	})

	assert.equal(result, 'https://www.youtube.com/watch?v=abc123DEF45')
	assert.equal(newsApiCalls, 0, 'newsapi fallback should not run when exact article html already contains YouTube')
	assert.deepEqual(
		fetchCalls,
		[
			'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc123DEF45&format=json',
			'https://www.youtube.com/watch?v=abc123DEF45&hl=en',
		],
	)
	assert.ok(logs.some(line => line.includes('VIDEOS exact article html candidates: 1')))
	assert.ok(logs.some(line => line.includes('VIDEOS from exact article html:')))
})

test('collectVideosFromTrustedSources skips unavailable ytrss video and picks available alternative', async () => {
	fetchCalls.length = 0
	fetchImpl = async (url) => {
		if (url === 'https://www.youtube.com/@Reuters') {
			return {
				ok: true,
				status: 200,
				text: async () => '<meta itemprop="channelId" content="UC12345678901234567890">',
			}
		}
		if (url === 'https://www.youtube.com/feeds/videos.xml?channel_id=UC12345678901234567890') {
			return {
				ok: true,
				status: 200,
				text: async () => `
					<feed>
						<entry>
							<yt:videoId>badVideo01A</yt:videoId>
							<title>McDonald's CEO Chris Kempczinski viral burger clip</title>
							<published>2026-03-06T19:00:00Z</published>
							<author><name>Reuters</name></author>
							<media:description>McDonald's CEO clip</media:description>
						</entry>
						<entry>
							<yt:videoId>goodVideo1B</yt:videoId>
							<title>McDonald's CEO Chris Kempczinski viral burger alternative angle</title>
							<published>2026-03-06T20:00:00Z</published>
							<author><name>Reuters</name></author>
							<media:description>McDonald's CEO alternative clip</media:description>
						</entry>
					</feed>
				`,
			}
		}
		if (url === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DbadVideo01A&format=json') {
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
			}
		}
		if (url === 'https://www.youtube.com/watch?v=badVideo01A&hl=en') {
			return {
				ok: true,
				status: 200,
				text: async () => `
					<meta property="og:title" content="Video unavailable">
					<script>var ytInitialPlayerResponse={"playabilityStatus":{"status":"ERROR","reason":"Video unavailable"}};</script>
				`,
			}
		}
		if (url === 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DgoodVideo1B&format=json') {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					title: 'McDonald\'s CEO Chris Kempczinski Viral Burger Bite',
					author_name: 'Reuters',
				}),
			}
		}
		if (url === 'https://www.youtube.com/watch?v=goodVideo1B&hl=en') {
			return {
				ok: true,
				status: 200,
				text: async () => `
					<meta property="og:title" content="McDonald's CEO Chris Kempczinski Viral Burger Bite">
					<meta property="og:description" content="Available Reuters clip">
					<script>var ytInitialPlayerResponse={"playabilityStatus":{"status":"OK"}};</script>
				`,
			}
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}

	let logs = []
	let result = await collectVideosFromTrustedSources({
		titleEn: 'McDonalds CEO viral moment',
		text: 'McDonalds CEO Chris Kempczinski viral burger moment article text.',
		url: 'https://example.com/story-two',
		usedUrl: 'https://example.com/story-two',
		source: 'Reuters',
		date: '2026-03-06T20:54:02.000Z',
		html: '',
	}, {
		logger: (...args) => logs.push(args.join(' ')),
	})

	assert.equal(result, 'https://www.youtube.com/watch?v=goodVideo1B')
	assert.ok(logs.some(line => line.includes('VIDEOS unavailable:') && line.includes('badVideo01A')))
	assert.ok(logs.some(line => line.includes('VIDEOS from ytrss channel:')))
})

test('gpt video websearch seeds stay source-language and do not fall back to translated russian title', async () => {
	process.env.VIDEO_GPT_WEBSEARCH = '1'
	process.env.OPENAI_API_KEY = 'test-key'

	let openaiCalls = []
	openaiPostImpl = async (_path, payload) => {
		openaiCalls.push(payload)
		return {
			outputText: JSON.stringify({ videos: [] }),
			usage: {},
		}
	}

	fetchCalls.length = 0
	fetchImpl = async () => ({
		ok: false,
		status: 404,
		statusText: 'Not Found',
		text: async () => '',
		json: async () => ({}),
	})

	let { collectVideosFromTrustedSources: collectWithGpt } = await import(`${mod('video-links.js')}?gpt-seeds`)
	await collectWithGpt({
		titleRu: 'Вирусный ролик с укусом бургера от главы McDonald’s',
		titleEn: '',
		text: 'McDonalds CEO Chris Kempczinski viral burger bite sparked debate over executive authenticity on social media.',
		url: 'https://observer.com/2026/03/mcdonalds-ceo-chris-kempczinski-social-media-moment/',
		usedUrl: 'https://observer.com/2026/03/mcdonalds-ceo-chris-kempczinski-social-media-moment/',
		source: 'Observer',
		date: '2026-03-06T20:54:02.000Z',
		html: '',
	}, {
		logger: () => {},
	})

	assert.equal(openaiCalls.length, 3)
	let querySeeds = openaiCalls
		.map(call => JSON.parse(call?.body?.user || '{}')?.querySeeds || [])
		.flat()
	assert.ok(querySeeds.length > 0)
	assert.ok(querySeeds.some(seed => /mcdonald|kempczinski/i.test(seed)))
	assert.ok(querySeeds.every(seed => !/[\u0400-\u04FF]/.test(seed)), 'query seeds should not contain Cyrillic')

	process.env.VIDEO_GPT_WEBSEARCH = '0'
	delete process.env.OPENAI_API_KEY
	openaiPostImpl = async () => ({ outputText: '', usage: {} })
})

test('gpt video websearch prefers original article title over feed titleEn in query seeds', async () => {
	process.env.VIDEO_GPT_WEBSEARCH = '1'
	process.env.OPENAI_API_KEY = 'test-key'

	let openaiCalls = []
	openaiPostImpl = async (_path, payload) => {
		openaiCalls.push(payload)
		return {
			outputText: JSON.stringify({ videos: [] }),
			usage: {},
		}
	}

	fetchCalls.length = 0
	fetchImpl = async () => ({
		ok: false,
		status: 404,
		statusText: 'Not Found',
		text: async () => '',
		json: async () => ({}),
	})

	let { collectVideosFromTrustedSources: collectWithOriginalTitle } = await import(`${mod('video-links.js')}?original-title`)
	await collectWithOriginalTitle({
		articleTitle: `McDonald's CEO Chris Kempczinski's Viral Burger Bite`,
		titleEn: 'Observer story about CEO authenticity moment',
		titleRu: '',
		text: 'McDonalds CEO Chris Kempczinski viral burger bite sparked debate over executive authenticity on social media.',
		url: 'https://observer.com/2026/03/mcdonalds-ceo-chris-kempczinski-social-media-moment/',
		usedUrl: 'https://observer.com/2026/03/mcdonalds-ceo-chris-kempczinski-social-media-moment/',
		source: 'Observer',
		date: '2026-03-06T20:54:02.000Z',
		html: '',
	}, {
		logger: () => {},
	})

	assert.equal(openaiCalls.length, 3)
	let querySeeds = openaiCalls
		.map(call => JSON.parse(call?.body?.user || '{}')?.querySeeds || [])
		.flat()
	assert.ok(querySeeds.some(seed => /viral burger bite/i.test(seed)))
	assert.ok(querySeeds.every(seed => !/observer story about ceo authenticity moment/i.test(seed)))

	process.env.VIDEO_GPT_WEBSEARCH = '0'
	delete process.env.OPENAI_API_KEY
	openaiPostImpl = async () => ({ outputText: '', usage: {} })
})
