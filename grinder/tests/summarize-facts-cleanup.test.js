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

const articleId = `facts-cleanup-${process.pid}`
const articleUrl = 'https://example.com/facts-cleanup'
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
		titleEn: 'Facts Cleanup Story',
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
		factsRu: '',
		arguments: 'Saved arguments block.',
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

mock.module(mod('newsapi.js'), {
	namedExports: {
		extractArticleAgency: async () => '',
		extractArticleDate: async () => '',
		extractArticleInfo: async () => null,
		findAlternativeArticles: async () => [],
	}
})

mock.module(mod('brightdata-article.js'), {
	namedExports: {
		extractArticleWithBrightData: async () => null,
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

let talkingPointsCalls = 0
let videoCalls = 0
mock.module(mod('enrich.js'), {
	namedExports: {
		collectAlternativeUrlsByStory: async () => [],
		collectFacts: async () => [
			'Джек Шлоссберг родился 19 января 1993 года. ([britannica.com](',
			'Его полное имя: John Bouvier Kennedy Schlossberg. ([britannica.com](',
			'Совет Кеннеди-центра одобрил название Trump-Kennedy Center. ([forbes.com](',
			'Надлер в Конгрессе США с 1991 года. https://congress.gov/member',
			'NY-12 включает Верхний Вест-Сайд. (en.wikipedia.org)',
			'([en.wikipedia.org](',
		].join('\n'),
		collectTalkingPoints: async () => {
			talkingPointsCalls++
			return ''
		},
		collectVideos: async () => {
			videoCalls++
			return ''
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

test('summarize strips links and citation tails from facts output', async () => {
	fs.mkdirSync(articlesDir, { recursive: true })
	const txtPath = path.join(articlesDir, `${articleId}.txt`)
	const htmlPath = path.join(articlesDir, `${articleId}.html`)
	fs.writeFileSync(
		txtPath,
		[
			`URL: ${articleUrl}`,
			'Title: Facts Cleanup Story',
			'Agency: Example Agency',
			'PublishedAt: 2026-03-09T08:00:00.000Z',
			'EventUri: ',
			'',
			articleText,
		].join('\n')
	)
	fs.writeFileSync(
		htmlPath,
		`<!--\n${articleUrl}\n-->\n<article><h1>Facts Cleanup Story</h1><p>${articleText}</p></article>`
	)

	await summarize()

	assert.equal(aiCalls, 0, 'summary should not rerun when only facts are missing')
	assert.equal(talkingPointsCalls, 0, 'arguments should not rerun when already filled')
	assert.equal(videoCalls, 0, 'videos should not rerun when already filled')
	assert.equal(
		news[0].factsRu,
		[
			'Джек Шлоссберг родился 19 января 1993 года.',
			'Его полное имя: John Bouvier Kennedy Schlossberg.',
			'Совет Кеннеди-центра одобрил название Trump-Kennedy Center.',
			'Надлер в Конгрессе США с 1991 года.',
			'NY-12 включает Верхний Вест-Сайд.',
		].join('\n')
	)
	assert.ok(!/https?:\/\/|www\.|britannica\.com|forbes\.com|wikipedia\.org/i.test(news[0].factsRu))
})
