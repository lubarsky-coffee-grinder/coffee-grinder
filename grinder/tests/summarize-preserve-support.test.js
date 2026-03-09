import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')
const articlesDir = path.join(rootDir, 'articles')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

const articleId = `preserve-support-${process.pid}`
const articleUrl = 'https://example.com/preserve-support'
const articleText = Array.from(
	{ length: 40 },
	(_, i) => `Cached article paragraph ${i + 1} about the same story.`
).join(' ')

const news = [
	{
		id: articleId,
		gnUrl: '',
		url: articleUrl,
		usedUrl: articleUrl,
		source: 'Example Source',
		agency: 'Example Agency',
		titleEn: 'Preserve Support Story',
		topic: '03. US',
		summary: '',
		priority: '',
		sqk: '',
		text: '',
		aiTopic: '',
		aiPriority: '',
		titleRu: '',
		date: '2026-03-09',
		alternativeUrls: '',
		factsRu: '- Saved fact one\n- Saved fact two',
		arguments: 'Saved talking point block that should stay untouched.',
		videoUrls: 'https://www.youtube.com/watch?v=abc123DEF45',
	},
]
news.headers = [
	'id',
	'gnUrl',
	'url',
	'usedUrl',
	'source',
	'agency',
	'titleEn',
	'topic',
	'summary',
	'priority',
	'sqk',
	'text',
	'aiTopic',
	'aiPriority',
	'titleRu',
	'date',
	'alternativeUrls',
	'factsRu',
	'arguments',
	'videoUrls',
]

mock.module(mod('store.js'), {
	namedExports: {
		news,
		save: async () => {},
	}
})

mock.module(mod('google-news.js'), {
	namedExports: {
		decodeGoogleNewsUrl: async () => '',
	}
})

let currentFlowExtractCalls = 0
mock.module(mod('newsapi.js'), {
	namedExports: {
		extractArticleAgency: async () => '',
		extractArticleDate: async () => '',
		extractArticleInfo: async () => {
			currentFlowExtractCalls++
			return null
		},
		findAlternativeArticles: async () => [],
	}
})

let brightDataCalls = 0
mock.module(mod('brightdata-article.js'), {
	namedExports: {
		extractArticleWithBrightData: async () => {
			brightDataCalls++
			return null
		},
		describeBrightDataArticleExtractionSettings: () => 'brightdata=mock',
	}
})

let aiCalls = 0
mock.module(mod('ai.js'), {
	namedExports: {
		ai: async () => {
			aiCalls++
			return {
				summary: 'Summary regenerated from cached article text.',
				topic: 'US',
				priority: 3,
				titleRu: 'Пересобранный заголовок',
				delay: 0,
			}
		},
	}
})

let factsCalls = 0
let talkingPointsCalls = 0
let videoCalls = 0
mock.module(mod('enrich.js'), {
	namedExports: {
		collectAlternativeUrlsByStory: async () => [],
		collectFacts: async () => {
			factsCalls++
			return '- unexpected facts refresh'
		},
		collectTalkingPoints: async () => {
			talkingPointsCalls++
			return 'unexpected talking points refresh'
		},
		collectVideos: async () => {
			videoCalls++
			return 'https://www.youtube.com/watch?v=unexpected'
		},
		collectTitleByUrl: async () => ({ titleEn: '', titleRu: '', extra: '' }),
		describeFactsSettings: () => 'model=mock',
		describeTalkingPointsSettings: () => 'model=mock',
		describeVideosSettings: () => 'model=mock',
		describeTitleLookupSettings: () => 'model=mock',
		describeAlternativeUrlLookupSettings: () => 'model=mock',
	}
})

mock.module(mod('fallback-keywords.js'), {
	namedExports: {
		extractFallbackKeywords: async () => [],
		describeFallbackKeywordsSettings: () => 'model=mock',
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

const originalArgv1 = process.argv[1]
process.argv[1] = 'node'
const { summarize } = await import(mod('2.summarize.js'))
process.argv[1] = originalArgv1

test('summarize preserves filled support columns when only summary is missing', async () => {
	fs.mkdirSync(articlesDir, { recursive: true })
	const txtPath = path.join(articlesDir, `${articleId}.txt`)
	const htmlPath = path.join(articlesDir, `${articleId}.html`)
	fs.writeFileSync(
		txtPath,
		[
			`URL: ${articleUrl}`,
			'Title: Preserve Support Story',
			'Agency: Example Agency',
			'PublishedAt: 2026-03-09T08:00:00.000Z',
			'EventUri: ',
			'',
			articleText,
		].join('\n')
	)
	fs.writeFileSync(
		htmlPath,
		`<!--\n${articleUrl}\n-->\n<article><h1>Preserve Support Story</h1><p>${articleText}</p></article>`
	)

	await summarize()

	assert.equal(brightDataCalls, 0, 'Bright Data should not run when cached article text is available')
	assert.equal(currentFlowExtractCalls, 0, 'current extract should not run when cached article text is available')
	assert.equal(factsCalls, 0, 'facts should not be regenerated when factsRu is already filled')
	assert.equal(talkingPointsCalls, 0, 'arguments should not be regenerated when already filled')
	assert.equal(videoCalls, 0, 'videoUrls should not be regenerated when already filled')
	assert.match(news[0].summary, /^Summary regenerated from cached article text\./)
	assert.equal(news[0].factsRu, '- Saved fact one\n- Saved fact two')
	assert.equal(news[0].arguments, 'Saved talking point block that should stay untouched.')
	assert.equal(news[0].videoUrls, 'https://www.youtube.com/watch?v=abc123DEF45')
})
