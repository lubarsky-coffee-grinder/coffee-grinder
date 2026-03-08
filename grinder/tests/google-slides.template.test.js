import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// Isolate module state between runs.
const resetModules = async () => {
	for (const key of Object.keys(import.meta.cache || {})) {
		delete import.meta.cache[key]
	}
}

test('slides use configured template presentation and placeholders', async () => {
	// Arrange env to point at a test template.
	process.env.GOOGLE_ROOT_FOLDER_ID = 'ROOT'
	process.env.GOOGLE_TEMPLATE_PRESENTATION_ID = 'TEST_TEMPLATE'
	process.env.GOOGLE_TEMPLATE_SLIDE_ID = 'TPL_SLIDE'
	process.env.GOOGLE_TEMPLATE_TABLE_ID = 'TPL_TABLE'
	process.env.GOOGLE_PRESENTATION_NAME = 'auto-test-presentation'

	const copyCalls = []
	const batchCalls = []

	// Mock Drive helpers.
	mock.module('../src/google-drive.js', {
		namedExports: {
			getFile: async () => null, // force copy
			copyFile: async (fileId, folderId, name) => {
				copyCalls.push({ fileId, folderId, name })
				return { id: 'NEW_PRESENTATION' }
			},
			moveFile: async () => {},
			createFolder: async () => 'FOLDER',
			trashFile: async () => {},
			uploadFolder: async () => {},
		}
	})

	// Mock auth to avoid reading real env config.
	mock.module('../src/google-auth.js', {
		namedExports: {
			auth: {},
		}
	})

	// Mock Slides API client.
	mock.module('@googleapis/slides', {
		defaultExport: {
			slides: async () => ({
				presentations: {
					get: async () => ({
						data: {
							slides: [
								{
									objectId: 'TPL_SLIDE',
									pageElements: [
										{
											objectId: 'TPL_TABLE',
											table: {
												tableRows: [
													{
														tableCells: [
															{
																text: {
																	textElements: [
																		{ textRun: { content: '{{title}}' } },
																	]
																}
															},
															{ text: { textElements: [] } },
														]
													},
													{
														tableCells: [
															{
																text: {
																	textElements: [
																		{ textRun: { content: '{{videos}}' } },
																	]
																}
															},
															{
																text: {
																	textElements: [
																		{ textRun: { content: '{{notes}}' } },
																	]
																}
															},
														]
													},
													{
														tableCells: [
															{ text: { textElements: [] } },
															{ text: { textElements: [] } },
														]
													},
												]
											}
										},
									]
								},
							]
						}
					}),
					batchUpdate: async params => {
						batchCalls.push(params)
						return {}
					}
				}
			})
		}
	})

	// Fresh import with mocks applied.
	await resetModules()
	const slides = await import('../src/google-slides.js')

	// Act: create presentation and add one slide.
	const presId = await slides.createPresentation()
		await slides.addSlide({
			sqk: 1,
			topicId: 3,
			topicSqk: 1,
			titleEn: 'Test title',
			summary: 'Test summary',
			priority: 2,
			url: 'https://example.com/article',
			arguments: [
				'“Первый длинный заголовок в кавычках” Очень длинный первый talking point example.com/with-link с дополнительными пояснениями и деталями для теста ограничения длины на слайде?',
				'“Второй длинный заголовок в кавычках” Ещё один длинный talking point с лишними словами, чтобы проверить автоматическое сжатие текста при вставке в notes?',
				'“Третий длинный заголовок в кавычках” Третий пример для проверки лимита количества talking points в блоке на слайде?',
				'“Четвертый длинный заголовок в кавычках” Этот пункт не должен попасть на слайд, потому что действует ограничение по количеству?',
			].join('\n\n'),
			factsRu: '- Тестовый факт || bad.example/fact-source',
		})

	// Assert template copy happened with the configured ID.
	assert.equal(presId, 'NEW_PRESENTATION')
	assert.equal(copyCalls.length, 1)
	assert.equal(copyCalls[0].fileId, 'TEST_TEMPLATE')
	assert.equal(copyCalls[0].folderId, 'ROOT')

	// Assert placeholder replacement uses cat{topicId}_card{topicSqk}.
	assert.ok(batchCalls.length > 0, 'Slides batchUpdate was not called')
	const replaceReq = batchCalls[0]?.requestBody?.requests?.find(
		r => r.replaceAllText?.containsText?.text === '{{cat3_card1}}'
	)
	assert.ok(replaceReq, 'Expected replaceAllText for {{cat3_card1}}')
	assert.match(String(replaceReq.replaceAllText?.replaceText), /^1\sTest title/)

	const notesReplaceReq = batchCalls[0]?.requestBody?.requests?.find(
		r => r.replaceAllText?.containsText?.text === '{{notes}}'
	)
	assert.equal(notesReplaceReq, undefined, 'Notes placeholder should be filled via direct cell update')

	const factsInsertReq = batchCalls[0]?.requestBody?.requests?.find(
		r => r.insertText?.cellLocation?.rowIndex === 1 && r.insertText?.cellLocation?.columnIndex === 1
	)
	assert.ok(factsInsertReq, 'Expected facts insert into {{notes}} cell')
	const factsText = String(factsInsertReq.insertText?.text)
	assert.match(factsText, /Факты:/)
	assert.ok(!/https?:\/\/|www\./i.test(factsText), 'Facts cell must not contain URLs')
	assert.ok(!/bad\.example/i.test(factsText), 'Facts cell must not contain bare domains')

	const argsInsertReq = batchCalls[0]?.requestBody?.requests?.find(
		r => r.insertText?.cellLocation?.rowIndex === 2 && r.insertText?.cellLocation?.columnIndex === 1
	)
	assert.ok(argsInsertReq, 'Expected arguments insert in next row cell')
	const argsText = String(argsInsertReq.insertText?.text)
	assert.match(argsText, /Аргументы:/)
	assert.ok(!/https?:\/\/|www\./i.test(argsText), 'Arguments cell must not contain URLs')
	assert.ok(!/example\.com/i.test(argsText), 'Arguments cell must not contain bare domains')

	const talkingBulletCount = (argsText.match(/^- /gm) || []).length
	assert.equal(talkingBulletCount, 4, 'Talking points on slide should keep all provided bullets')
})

test.after(async () => {
	mock.reset()
	await resetModules()
})
