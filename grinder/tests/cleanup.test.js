import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')
const configDir = path.join(rootDir, 'config')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href
const configMod = relativePath => pathToFileURL(path.join(configDir, relativePath)).href

const news = [
	{
		id: 1,
		titleEn: 'Ready title',
		titleRu: '',
		summary: 'Ready summary',
		url: 'https://example.com/ready',
		agency: 'Ready Agency',
		factsRu: '- ready fact',
		arguments: 'Ready arguments',
		videoUrls: '- https://youtube.com/watch?v=ready',
		date: '2026-03-08',
		alternativeUrls: 'https://example.com/alt-ready',
		usedUrl: 'https://example.com/ready',
		duplicateUrl: 'dup-ready',
		talkingPointsRu: 'legacy ready value',
	},
	{
		id: 2,
		titleEn: '',
		titleRu: '',
		summary: '',
		url: 'https://example.com/incomplete',
		agency: 'Incomplete Agency',
		factsRu: '- stale fact',
		arguments: 'Stale arguments',
		videoUrls: '- https://youtube.com/watch?v=stale',
		date: '2026-03-07',
		alternativeUrls: 'https://example.com/alt-stale',
		usedUrl: 'https://example.com/incomplete',
		duplicateUrl: 'dup-stale',
		talkingPointsRu: 'legacy stale value',
	},
	{
		id: 3,
		titleEn: 'Missing link title',
		titleRu: '',
		summary: 'Has summary but no source link',
		url: '',
		gnUrl: '',
		agency: 'No Link Agency',
		factsRu: '- no-link fact',
		arguments: 'No-link arguments',
		videoUrls: '- https://youtube.com/watch?v=no-link',
		date: '2026-03-06',
		alternativeUrls: 'https://example.com/alt-no-link',
		usedUrl: 'https://example.com/no-link',
		duplicateUrl: 'dup-no-link',
			talkingPointsRu: 'legacy no-link value',
		},
		{
			id: 4,
			titleEn: 'Title only',
			titleRu: '',
			summary: '',
			url: 'https://example.com/title-only',
			agency: 'Title Only Agency',
			factsRu: '- keep fact',
			arguments: 'Keep arguments',
			videoUrls: '- https://youtube.com/watch?v=title-only',
			date: '2026-03-05',
			alternativeUrls: 'https://example.com/alt-title-only',
			usedUrl: 'https://example.com/title-only',
			duplicateUrl: 'dup-title-only',
			talkingPointsRu: 'legacy title-only value',
		},
		{
			id: 5,
			titleEn: '',
			titleRu: '',
			summary: 'Summary only',
			url: 'https://example.com/summary-only',
			agency: 'Summary Only Agency',
			factsRu: '- keep summary-only fact',
			arguments: 'Keep summary-only arguments',
			videoUrls: '- https://youtube.com/watch?v=summary-only',
			date: '2026-03-04',
			alternativeUrls: 'https://example.com/alt-summary-only',
			usedUrl: 'https://example.com/summary-only',
			duplicateUrl: 'dup-summary-only',
			talkingPointsRu: 'legacy summary-only value',
		},
]
news.headers = [
	'id',
	'titleEn',
	'titleRu',
	'summary',
	'url',
	'gnUrl',
	'agency',
	'factsRu',
	'arguments',
	'videoUrls',
	'date',
	'alternativeUrls',
	'usedUrl',
	'duplicateUrl',
	'talkingPointsRu',
]

let saveCalls = 0
let archiveCalls = 0

mock.module(mod('store.js'), {
	namedExports: {
		news,
		save: async () => {
			saveCalls++
		},
	}
})

mock.module(mod('google-slides.js'), {
	namedExports: {
		archivePresentation: async () => {
			archiveCalls++
			return ''
		},
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

mock.module(mod('google-drive.js'), {
	namedExports: {
		copyFile: async () => {},
		getFile: async () => null,
		moveFile: async () => {},
	}
})

mock.module(configMod('google-drive.js'), {
	namedExports: {
		rootFolderId: 'root-folder',
		archiveFolderId: 'archive-folder',
		autoArchiveFolderId: 'auto-archive-folder',
		audioFolderName: 'audio',
		imageFolderName: 'img',
	}
})

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

mock.module(mod('run-links.js'), {
	namedExports: {
		recordRunLink: () => {},
		folderLink: value => value,
		presentationLink: value => value,
	}
})

const originalArgv1 = process.argv[1]
process.argv[1] = 'node'

const { cleanup } = await import(mod('0.cleanup.js'))
process.argv[1] = originalArgv1

test('cleanup preserves complete rows, clears invalid rows, and leaves partial rows untouched', async () => {
	await cleanup()

	assert.equal(saveCalls, 1, 'cleanup should save once after reconciling rows')
	assert.equal(archiveCalls, 1, 'cleanup should still archive previous presentation snapshot')

	assert.equal(news[0].agency, 'Ready Agency')
	assert.equal(news[0].factsRu, '- ready fact')
	assert.equal(news[0].arguments, 'Ready arguments')
	assert.equal(news[0].videoUrls, '- https://youtube.com/watch?v=ready')
	assert.equal(news[0].date, '2026-03-08')
	assert.equal(news[0].alternativeUrls, 'https://example.com/alt-ready')
	assert.equal(news[0].usedUrl, 'https://example.com/ready')
	assert.equal(news[0].duplicateUrl, 'dup-ready')
	assert.equal(news[0].talkingPointsRu, '')

	assert.equal(news[1].agency, '')
	assert.equal(news[1].factsRu, '')
	assert.equal(news[1].arguments, '')
	assert.equal(news[1].videoUrls, '')
	assert.equal(news[1].date, '')
	assert.equal(news[1].alternativeUrls, '')
	assert.equal(news[1].usedUrl, '')
	assert.equal(news[1].duplicateUrl, '')
	assert.equal(news[1].talkingPointsRu, '')

	assert.equal(news[2].agency, '')
	assert.equal(news[2].factsRu, '')
	assert.equal(news[2].arguments, '')
	assert.equal(news[2].videoUrls, '')
	assert.equal(news[2].date, '')
	assert.equal(news[2].alternativeUrls, '')
	assert.equal(news[2].usedUrl, '')
	assert.equal(news[2].duplicateUrl, '')
	assert.equal(news[2].talkingPointsRu, '')

	assert.equal(news[3].agency, 'Title Only Agency')
	assert.equal(news[3].factsRu, '- keep fact')
	assert.equal(news[3].arguments, 'Keep arguments')
	assert.equal(news[3].videoUrls, '- https://youtube.com/watch?v=title-only')
	assert.equal(news[3].date, '2026-03-05')
	assert.equal(news[3].alternativeUrls, 'https://example.com/alt-title-only')
	assert.equal(news[3].usedUrl, 'https://example.com/title-only')
	assert.equal(news[3].duplicateUrl, 'dup-title-only')
	assert.equal(news[3].talkingPointsRu, '')

	assert.equal(news[4].agency, 'Summary Only Agency')
	assert.equal(news[4].factsRu, '- keep summary-only fact')
	assert.equal(news[4].arguments, 'Keep summary-only arguments')
	assert.equal(news[4].videoUrls, '- https://youtube.com/watch?v=summary-only')
	assert.equal(news[4].date, '2026-03-04')
	assert.equal(news[4].alternativeUrls, 'https://example.com/alt-summary-only')
	assert.equal(news[4].usedUrl, 'https://example.com/summary-only')
	assert.equal(news[4].duplicateUrl, 'dup-summary-only')
	assert.equal(news[4].talkingPointsRu, '')
})
