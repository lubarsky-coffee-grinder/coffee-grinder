import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

const news = [
	{
		id: `skip-video-refill-${process.pid}`,
		gnUrl: '',
		url: 'https://example.com/already-finished-story',
		usedUrl: 'https://example.com/already-finished-story',
		source: 'Example Source',
		agency: 'Example Agency',
		titleEn: 'Finished Story Title',
		topic: '03. US',
		summary: 'Existing finished summary.',
		priority: '',
		sqk: '',
		text: '',
		aiTopic: '',
		aiPriority: '',
		titleRu: 'Готовый заголовок',
		date: '2026-03-09',
		alternativeUrls: '',
		factsRu: '- Saved fact one',
		arguments: 'Saved arguments block.',
		videoUrls: '',
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

let extractCalls = 0
mock.module(mod('newsapi.js'), {
	namedExports: {
		extractArticleAgency: async () => '',
		extractArticleDate: async () => '',
		extractArticleInfo: async () => {
			extractCalls++
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
			return null
		},
	}
})

let factsCalls = 0
let talkingPointsCalls = 0
let videoCalls = 0
let titleLookupCalls = 0
mock.module(mod('enrich.js'), {
	namedExports: {
		collectAlternativeUrlsByStory: async () => [],
		collectFacts: async () => {
			factsCalls++
			return ''
		},
		collectTalkingPoints: async () => {
			talkingPointsCalls++
			return ''
		},
		collectVideos: async () => {
			videoCalls++
			return 'https://www.youtube.com/watch?v=unexpected'
		},
		collectTitleByUrl: async () => {
			titleLookupCalls++
			return { titleEn: '', titleRu: '', extra: '' }
		},
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

test('summarize does not retry video collection for rows with ready title and summary', async () => {
	await summarize()

	assert.equal(aiCalls, 0, 'summary should not rerun for finished rows')
	assert.equal(factsCalls, 0, 'facts should not rerun for finished rows')
	assert.equal(talkingPointsCalls, 0, 'arguments should not rerun for finished rows')
	assert.equal(videoCalls, 0, 'videos should not rerun when title and summary are already filled')
	assert.equal(titleLookupCalls, 0, 'title lookup should not run for finished rows')
	assert.equal(brightDataCalls, 0, 'Bright Data should not run for finished rows')
	assert.equal(extractCalls, 0, 'current extract should not run for finished rows')
	assert.equal(news[0].videoUrls, '')
})
