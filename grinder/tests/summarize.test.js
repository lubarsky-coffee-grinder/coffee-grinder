import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')
const fixturesDir = path.join(rootDir, 'tests', 'fixtures', 'summarize')
const articlesDir = path.join(rootDir, 'articles')

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

const fixtureNews = readJson(path.join(fixturesDir, 'news.json'))
const fixtureNewsApi = readJson(path.join(fixturesDir, 'newsapi.json'))
const fixtureAi = readJson(path.join(fixturesDir, 'ai.json'))
const fixtureGoogleNews = readJson(path.join(fixturesDir, 'google-news.json'))

function cloneRows(rows) {
	return JSON.parse(JSON.stringify(rows))
}

const testIdPrefix = `test-${process.pid}-`
const newsRows = cloneRows(fixtureNews.rows ?? fixtureNews).map((row, index) => ({
	...row,
	id: `${testIdPrefix}${row?.id ?? index + 1}`,
}))
const news = newsRows.map(row => ({ ...row }))

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

mock.module(mod('store.js'), {
	namedExports: {
		news,
		save: async () => {},
	}
})

mock.module(mod('google-news.js'), {
	namedExports: {
		decodeGoogleNewsUrl: async (url) => fixtureGoogleNews[url],
	}
})

mock.module(mod('fetch-article.js'), {
	namedExports: {
		fetchArticle: async () => {
			throw new Error('fetchArticle() should not be used; summarize must use newsapi.ai')
		},
	}
})

mock.module(mod('browse-article.js'), {
	namedExports: {
		browseArticle: async () => {
			throw new Error('browseArticle() should not be used; summarize must use newsapi.ai')
		},
		finalyze: async () => {
			throw new Error('finalyze() should not be used; summarize must use newsapi.ai')
		},
	}
})

mock.module(mod('brightdata-article.js'), {
	namedExports: {
		extractArticleWithBrightData: async () => null,
		describeBrightDataArticleExtractionSettings: () => 'brightdata=mock',
	}
})

const extractCalls = new Map()
const altCalls = new Map()
mock.module(mod('newsapi.js'), {
	namedExports: {
		extractArticleAgency: async (url) => fixtureNewsApi[url]?.source || '',
		extractArticleDate: async (url) => fixtureNewsApi[url]?.publishedAt || '',
		extractArticleInfo: async (url) => {
			extractCalls.set(url, (extractCalls.get(url) || 0) + 1)

			if (url === 'https://example.com/article-one') {
				return { title: 'Article One', body: '' }
			}

			if (url === 'https://example.com/article-two' && extractCalls.get(url) === 1) {
				return { title: 'Article Two', body: '' }
			}

			return fixtureNewsApi[url]
		},
			findAlternativeArticles: async (url) => {
				altCalls.set(url, (altCalls.get(url) || 0) + 1)

				if (url === 'https://example.com/article-one') {
					return [
						{ url: 'https://alt.example.com/article-one-alt', source: 'Alt Agency' },
					]
				}

				return []
			},
	}
})

mock.module(mod('ai.js'), {
	namedExports: {
		ai: async ({ url, text }) => {
			const res = fixtureAi[url]
			if (!res) return null
			return {
				summary: res.summary ?? text?.slice(0, 200) ?? '',
				topic: res.topic ?? 'US',
				priority: res.priority ?? 5,
				titleRu: res.titleRu,
				delay: 0,
			}
		}
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

	mock.module(mod('enrich.js'), {
		namedExports: {
			collectAlternativeUrlsByStory: async () => [],
			collectFacts: async ({ url }) => `- Факт для ${url}\n- Еще один факт`,
			collectTalkingPoints: async ({ url }) => [
				`“Кто платит, тот задаёт рамку решения” В истории по ${url} источники ресурсов определяют границы допустимых действий и переговорную позицию участников. Если финансовые потоки управляются извне, автономия решений становится условной. Где заканчивается поддержка и начинается внешнее управление?`,
				`“Доверие к институтам проверяется ценой ошибки” Реакция системы на сигнал зависит не от громкости заявлений, а от репутационного капитала тех, кто сигнал подаёт. Когда прошлые просчёты не разобраны публично, даже точные предупреждения воспринимаются как давление. Кто оплачивает стоимость институционального недоверия?`,
				`“Стимулы сильнее деклараций о принципах” Формальные заявления сторон выглядят последовательными, но поведение обычно следует за материальными стимулами и санкционными рисками. Поэтому реальные решения часто противоречат официальной риторике и ожиданиям аудитории. Какие стимулы здесь главные, а какие лишь витрина?`,
				`“Цифры создают иллюзию управляемости процесса” Публичные метрики дают ощущение контроля, но без контекста источников, горизонта и методики они легко превращаются в политический аргумент. Одни и те же числа могут обосновывать противоположные стратегии. Какие допущения скрыты за этими цифрами?`,
				`“Легитимность держится на прозрачности процедуры” Даже прагматичное решение теряет поддержку, если обществу не объяснены критерии выбора и цена альтернатив. Институциональная устойчивость возникает не из лозунгов, а из предсказуемых правил и подотчётности. Кто выигрывает, когда процедура остаётся непрозрачной?`,
			].join('\n\n'),
			collectVideos: async ({ url }) => `- https://youtube.com/watch?v=mock-${encodeURIComponent(url)}`,
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

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

const { summarize } = await import(mod('2.summarize.js'))

test('summarize pipeline (mocked)', async () => {
	const realDateNow = Date.now
	Date.now = () => new Date('2026-03-09T00:00:00.000Z').getTime()
	fs.mkdirSync(articlesDir, { recursive: true })
	try {
		for (const row of newsRows) {
			const htmlPath = path.join(articlesDir, `${row.id}.html`)
			const txtPath = path.join(articlesDir, `${row.id}.txt`)
			if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath)
			if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath)
		}

		await summarize()

		assert.equal(extractCalls.get('https://example.com/article-one'), 2, 'article-one should be retried once')
		assert.equal(extractCalls.get('https://alt.example.com/article-one-alt'), 1, 'fallback agency should be used after retries')
		assert.equal(extractCalls.get('https://example.com/article-two'), 2, 'article-two should be retried once')
		assert.equal(altCalls.get('https://example.com/article-one'), 1, 'alternative lookup should be called for article-one')

	const byId = new Map(news.map(item => [String(item.id), item]))

	for (const row of newsRows) {
		if (row.topic === 'other') continue
		const updated = byId.get(String(row.id))
		assert.ok(updated, `Missing updated row for id=${row.id}`)
		assert.ok(updated.summary && String(updated.summary).length > 10, `Missing summary for id=${row.id}`)
		assert.match(
			String(updated.summary),
			/(по данным|об этом сообщает|как пишет)/i,
			`Missing attribution phrase for id=${row.id}`
		)
		if (updated.agency) {
			assert.ok(
				String(updated.summary).toLowerCase().includes(String(updated.agency).toLowerCase()),
				`Missing agency label in summary for id=${row.id}`
			)
		}
		if (String(row.gnUrl || '').includes('test-gn-1')) {
			assert.equal(updated.agency, 'Alt Agency', `Unexpected fallback agency for id=${row.id}`)
		}
		if (String(row.url || '').includes('article-two')) {
			assert.equal(updated.agency, 'example.com', `Expected domain fallback for id=${row.id}`)
		}
		if (row.agency) {
			assert.notEqual(updated.agency, row.agency, `Agency should be overwritten for id=${row.id}`)
		}
		if (updated.source) {
			assert.ok(
				!String(updated.summary).toLowerCase().includes(String(updated.source).toLowerCase()),
				`Technical source leaked into summary attribution for id=${row.id}`
			)
		}
		assert.ok(updated.factsRu && String(updated.factsRu).length > 10, `Missing factsRu for id=${row.id}`)
		assert.ok(updated.arguments && String(updated.arguments).length > 10, `Missing arguments for id=${row.id}`)
		assert.ok(updated.videoUrls && String(updated.videoUrls).length > 10, `Missing videoUrls for id=${row.id}`)
		assert.ok(updated.aiTopic, `Missing aiTopic for id=${row.id}`)
		assert.ok(updated.aiPriority, `Missing aiPriority for id=${row.id}`)
		assert.ok(updated.agency, `Missing agency for id=${row.id}`)
		assert.ok(updated.date, `Missing date for id=${row.id}`)
		if (row.gnUrl) {
			assert.ok(updated.usedUrl, `Missing usedUrl for id=${row.id}`)
		}
		const htmlPath = path.join(articlesDir, `${row.id}.html`)
		const txtPath = path.join(articlesDir, `${row.id}.txt`)
		assert.ok(fs.existsSync(htmlPath), `Missing html output for id=${row.id}`)
		assert.ok(fs.existsSync(txtPath), `Missing txt output for id=${row.id}`)
			const txtContent = fs.readFileSync(txtPath, 'utf8')
			assert.match(txtContent, /^Agency:\s+/m, `Missing cache agency metadata for id=${row.id}`)
			assert.match(txtContent, /^PublishedAt:\s+/m, `Missing cache publishedAt metadata for id=${row.id}`)
			assert.match(txtContent, /^EventUri:\s+/m, `Missing cache eventUri metadata for id=${row.id}`)
		}
	} finally {
		Date.now = realDateNow
	}
})
