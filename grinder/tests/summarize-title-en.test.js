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

const cachedId = `title-en-cache-${process.pid}`
const lookupId = `title-en-lookup-${process.pid}`
const cachedUrl = 'https://example.com/title-from-cache'
const lookupUrl = 'https://example.com/title-from-lookup'

const news = [
	{
		id: cachedId,
		gnUrl: '',
		url: cachedUrl,
		usedUrl: cachedUrl,
		source: 'Example Source',
		agency: 'Example Agency',
		titleEn: '',
		topic: '03. US',
		summary: 'Existing summary.',
		priority: '',
		sqk: '',
		text: '',
		aiTopic: '',
		aiPriority: '',
		titleRu: 'Существующий заголовок',
		date: '2026-03-09',
		alternativeUrls: '',
		factsRu: '- Saved fact one',
		arguments: 'Saved arguments block.',
		videoUrls: 'https://www.youtube.com/watch?v=abc123DEF45',
	},
	{
		id: lookupId,
		gnUrl: '',
		url: lookupUrl,
		usedUrl: lookupUrl,
		source: 'Example Source',
		agency: 'Example Agency',
		titleEn: '',
		topic: '03. US',
		summary: 'Existing summary.',
		priority: '',
		sqk: '',
		text: '',
		aiTopic: '',
		aiPriority: '',
		titleRu: 'Существующий заголовок',
		date: '2026-03-09',
		alternativeUrls: '',
		factsRu: '- Saved fact one',
		arguments: 'Saved arguments block.',
		videoUrls: 'https://www.youtube.com/watch?v=def456GHI78',
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
			return ''
		},
		collectTitleByUrl: async ({ url }) => {
			titleLookupCalls++
			if (url === lookupUrl) {
				return {
					titleEn: 'Lookup English Title',
					titleRu: '',
					extra: '',
				}
			}
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

test('summarize backfills missing titleEn from cache and URL lookup without rerunning enrichments', async () => {
	fs.mkdirSync(articlesDir, { recursive: true })

	for (let id of [cachedId, lookupId]) {
		let htmlPath = path.join(articlesDir, `${id}.html`)
		let txtPath = path.join(articlesDir, `${id}.txt`)
		if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath)
		if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath)
	}

	fs.writeFileSync(
		path.join(articlesDir, `${cachedId}.txt`),
		[
			`URL: ${cachedUrl}`,
			'Title: Cached English Title',
			'Agency: Example Agency',
			'PublishedAt: 2026-03-09T08:00:00.000Z',
			'EventUri: ',
			'',
			'Cached article text that should only be used to backfill titleEn.',
		].join('\n')
	)

	await summarize()

	assert.equal(news[0].titleEn, 'Cached English Title')
	assert.equal(news[1].titleEn, 'Lookup English Title')
	assert.equal(titleLookupCalls, 1, 'title lookup should only run for the row without cached title')
	assert.equal(brightDataCalls, 0, 'Bright Data should not run when only titleEn is missing')
	assert.equal(extractCalls, 0, 'current extract should not run when only titleEn is missing')
	assert.equal(aiCalls, 0, 'summary should not rerun when only titleEn is missing')
	assert.equal(factsCalls, 0, 'facts should not rerun when only titleEn is missing')
	assert.equal(talkingPointsCalls, 0, 'arguments should not rerun when only titleEn is missing')
	assert.equal(videoCalls, 0, 'videos should not rerun when only titleEn is missing')
})
