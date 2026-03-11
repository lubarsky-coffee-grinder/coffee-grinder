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
const longText = Array.from(
	{ length: 40 },
	(_, i) => `Original story title alt article paragraph ${i + 1}.`
).join(' ')

const news = [
	{
		id: 'gpt-fallback-1',
		gnUrl: '',
		url: 'https://example.com/original-story',
		source: 'Original Agency',
		agency: '',
		titleEn: 'Original Story Title',
		topic: '03. US',
		summary: '',
		priority: '',
		sqk: '',
		text: '',
		aiTopic: '',
		aiPriority: '',
		titleRu: '',
		date: '',
		usedUrl: '',
		alternativeUrls: '',
		factsRu: '',
		arguments: '',
		videoUrls: '',
	},
]
news.headers = [
	'id',
	'gnUrl',
	'url',
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
	'usedUrl',
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

mock.module(mod('ai.js'), {
	namedExports: {
		ai: async () => ({
			summary: 'Summary from mocked AI output for fallback article.',
			topic: 'US',
			priority: 2,
			titleRu: 'Заголовок запасной статьи',
			delay: 0,
		}),
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

let currentFlowExtractCalls = 0
let currentFlowAltCalls = 0
mock.module(mod('newsapi.js'), {
	namedExports: {
		extractArticleAgency: async () => '',
		extractArticleDate: async () => '',
		extractArticleInfo: async () => {
			currentFlowExtractCalls++
			return null
		},
		findAlternativeArticles: async () => {
			currentFlowAltCalls++
			return []
		},
	}
})

let brightDataCalls = []
mock.module(mod('brightdata-article.js'), {
	namedExports: {
		extractArticleWithBrightData: async (url) => {
			brightDataCalls.push(url)
			if (url === 'https://alt.example.com/story') {
				return {
					title: 'Original Story Title (Alt Agency)',
					body: longText,
					bodyHtml: `<article><h1>Original Story Title (Alt Agency)</h1><p>${longText}</p></article>`,
					publishedAt: '2026-03-08T10:00:00.000Z',
					source: 'Alt Agency',
				}
			}
			return null
		},
		describeBrightDataArticleExtractionSettings: () => 'brightdata=mock',
	}
})

let gptAltLookupCalls = 0
mock.module(mod('enrich.js'), {
	namedExports: {
		collectAlternativeUrlsByStory: async () => {
			gptAltLookupCalls++
			return [
				{
					url: 'https://alt.example.com/story',
					source: 'Alt Agency',
					title: 'Original Story Title (Alt Agency)',
					publishedAt: '2026-03-08T10:00:00.000Z',
					reason: 'same event',
				},
			]
		},
		collectFacts: async () => '- fallback fact\n- another fact',
		collectTalkingPoints: async () => [
			'“Первый тезис для эфира” Здесь есть достаточно материала для анализа и обсуждения решения сторон. Какие стимулы определяют рамку публичных заявлений?',
			'“Второй тезис для эфира” Источник альтернативной статьи помогает восстановить картину события без потери контекста. Кто выигрывает от смены площадки публикации?',
			'“Третий тезис для эфира” Надёжность канала доставки данных становится частью редакционного процесса, а не только технической деталью. Где проходит граница между стабильностью и зависимостью?',
			'“Четвёртый тезис для эфира” Когда исходный URL не отдаёт текст, запасной источник спасает выпуск и уменьшает задержку. Какой ценой достигается такая отказоустойчивость?',
			'“Пятый тезис для эфира” Альтернативная публикация полезна только если это та же история, а не общий фон вокруг темы. Какие признаки совпадения мы считаем достаточными?',
		].join('\n\n'),
		collectVideos: async () => '- https://youtube.com/watch?v=alt-story',
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
		extractFallbackKeywords: async () => ['original', 'story'],
		describeFallbackKeywordsSettings: () => 'model=mock',
	}
})

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

const { summarize } = await import(mod('2.summarize.js'))

test('summarize uses GPT alternative URL before current flow when bright data exact URL fails', async () => {
	fs.mkdirSync(articlesDir, { recursive: true })
	for (let ext of ['html', 'txt']) {
		let filePath = path.join(articlesDir, `${news[0].id}.${ext}`)
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
	}

	await summarize()

	assert.equal(gptAltLookupCalls, 1, 'GPT alternative lookup should run once')
	assert.deepEqual(
		brightDataCalls,
		['https://example.com/original-story', 'https://alt.example.com/story'],
		'Bright Data should try original URL first, then GPT candidate URL',
	)
	assert.equal(currentFlowExtractCalls, 0, 'Current direct flow should not run after GPT fallback succeeds')
	assert.equal(currentFlowAltCalls, 0, 'Current alternative search should not run after GPT fallback succeeds')

	assert.equal(news[0].usedUrl, 'https://alt.example.com/story')
	assert.equal(news[0].agency, 'Alt Agency')
	assert.equal(news[0].titleEn, 'Original Story Title (Alt Agency)')
	assert.ok(String(news[0].summary).length > 10, 'summary should be filled')
	assert.ok(String(news[0].alternativeUrls).includes('https://alt.example.com/story'))
})
