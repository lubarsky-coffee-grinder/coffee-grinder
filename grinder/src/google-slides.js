import Slides from '@googleapis/slides'
import { nanoid } from 'nanoid'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { auth } from './google-auth.js'
import { copyFile, moveFile, getFile } from './google-drive.js'
import {
  rootFolderId,
  presentationName,
  autoPresentationName,
  templatePresentationId,
  templateSlideId,
  templateTableId,
  archiveFolderId,
  autoArchiveFolderId
} from '../config/google-drive.js'

const argvIndexParam = 2
const isAutoMode = () => process.argv[argvIndexParam]?.endsWith('auto')

function activePresentationName() {
	return isAutoMode() ? autoPresentationName : presentationName
}

function activeArchiveFolderId() {
	return isAutoMode() ? autoArchiveFolderId : archiveFolderId
}

function currentRunTag() {
	let value = String(process.env.RUN_TAG || '').trim()
	if (value) return value
	let d = new Date()
	let pad = n => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

let slides, presentationId
let resolvedTemplateSlideId
let resolvedTemplateTableId
let resolvedTemplateSlidesCount
let resolvedTemplatePlaceholderCells
let resolvedTemplateNotesTextShapeIds

async function resolveTemplateSlideId() {
	if (resolvedTemplateSlideId) return resolvedTemplateSlideId
	if (templateSlideId) {
		resolvedTemplateSlideId = templateSlideId
		return resolvedTemplateSlideId
	}

	const presentationIdParam = templatePresentationId
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	const templateSlides = response.data?.slides
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(templateSlides)) {
		resolvedTemplateSlidesCount = templateSlides.length
	}
	const firstSlideId = templateSlides?.[0]?.objectId
	if (!firstSlideId) {
		throw new Error('Template presentation has no slides to infer template slide id')
	}
	resolvedTemplateSlideId = firstSlideId
	return resolvedTemplateSlideId
}

async function resolveTemplateTableId() {
	if (resolvedTemplateTableId) return resolvedTemplateTableId
	if (templateTableId) {
		resolvedTemplateTableId = templateTableId
		return resolvedTemplateTableId
	}

	const presentationIdParam = templatePresentationId
	const slideIdParam = await resolveTemplateSlideId()
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(response.data?.slides)) {
		resolvedTemplateSlidesCount = response.data.slides.length
	}
	const slide = response.data?.slides?.find(s => s.objectId === slideIdParam)
	const template = slide ?? response.data?.slides?.[0]
	const table = template?.pageElements?.find(e => e.table && e.objectId)
	if (!table?.objectId) {
		throw new Error(`Template slide ${slideIdParam} has no table object to duplicate`)
	}

	resolvedTemplateTableId = table.objectId
	return resolvedTemplateTableId
}

function readCellText(cell) {
	const textElements = cell?.text?.textElements || []
	let out = ''
	for (const part of textElements) {
		out += part?.textRun?.content || ''
	}
	return out
}

function readTextElements(textElements) {
	let out = ''
	for (const part of textElements || []) {
		out += part?.textRun?.content || ''
	}
	return out
}

function findCategoryCardPlaceholders(text) {
	let raw = String(text || '')
	let matches = raw.match(/\{\{cat\d+_card\d+\}\}/g) || []
	return matches.map(v => String(v || '').trim()).filter(Boolean)
}

async function findUnfilledCategoryCardTargets() {
	await init
	const createdPresentationId = await createPresentation()
	presentationId = createdPresentationId
	const response = await slides.presentations.get({ presentationId })
	const presentationSlides = response.data?.slides || []
	const placeholders = new Set()
	const shapeObjectIds = new Set()

	for (const slide of presentationSlides) {
		for (const element of slide?.pageElements || []) {
			const shapeText = readTextElements(element?.shape?.text?.textElements || [])
			const shapeMatches = findCategoryCardPlaceholders(shapeText)
			if (shapeMatches.length) {
				for (const match of shapeMatches) placeholders.add(match)
				if (element?.objectId) shapeObjectIds.add(element.objectId)
			}

			const tableRows = element?.table?.tableRows || []
			for (const row of tableRows) {
				for (const cell of row?.tableCells || []) {
					const cellMatches = findCategoryCardPlaceholders(readCellText(cell))
					for (const match of cellMatches) placeholders.add(match)
				}
			}
		}
	}

	return {
		placeholders: [...placeholders],
		shapeObjectIds: [...shapeObjectIds],
	}
}

async function resolveTemplatePlaceholderCells() {
	if (resolvedTemplatePlaceholderCells) return resolvedTemplatePlaceholderCells

	const presentationIdParam = templatePresentationId
	const slideIdParam = await resolveTemplateSlideId()
	const tableIdParam = await resolveTemplateTableId()
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(response.data?.slides)) {
		resolvedTemplateSlidesCount = response.data.slides.length
	}
	const slide = response.data?.slides?.find(s => s.objectId === slideIdParam) ?? response.data?.slides?.[0]
	const table = slide?.pageElements?.find(e => e.objectId === tableIdParam && e.table)?.table

	const placeholders = ['{{title}}', '{{videos}}', '{{notes}}', '{{arguments}}']
	const out = {}
	const tableRows = table?.tableRows || []
	const rowColumnCounts = tableRows.map(row => row?.tableCells?.length || 0)
	for (let rowIndex = 0; rowIndex < (table?.tableRows?.length || 0); rowIndex++) {
		const row = table.tableRows[rowIndex]
		for (let columnIndex = 0; columnIndex < (row?.tableCells?.length || 0); columnIndex++) {
			const cell = row.tableCells[columnIndex]
			const cellText = readCellText(cell)
			for (const placeholder of placeholders) {
				if (!out[placeholder] && cellText.includes(placeholder)) {
					out[placeholder] = { rowIndex, columnIndex }
				}
			}
		}
	}
	out.__meta = {
		rowCount: tableRows.length,
		rowColumnCounts,
	}

	resolvedTemplatePlaceholderCells = out
	return resolvedTemplatePlaceholderCells
}

async function resolveTemplateNotesTextShapeIds() {
	if (resolvedTemplateNotesTextShapeIds) return resolvedTemplateNotesTextShapeIds

	const presentationIdParam = templatePresentationId
	const slideIdParam = await resolveTemplateSlideId()
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(response.data?.slides)) {
		resolvedTemplateSlidesCount = response.data.slides.length
	}
	const slide = response.data?.slides?.find(s => s.objectId === slideIdParam) ?? response.data?.slides?.[0]
	const notesElements = slide?.slideProperties?.notesPage?.pageElements || []

	const ids = []
	for (const e of notesElements) {
		if (!e?.objectId) continue
		if (!e?.shape?.text) continue
		ids.push(e.objectId)
	}
	resolvedTemplateNotesTextShapeIds = ids
	return resolvedTemplateNotesTextShapeIds
}

async function resolveCurrentSlidesCount() {
	await init
	if (!presentationId) return 0
	const response = await slides.presentations.get({ presentationId })
	let list = response.data?.slides
	return Array.isArray(list) ? list.length : 0
}

// ???????????????????? ?????????????? write-???????????????? ?? Slides API
// ??????????: ?????????? ?????????????? ???? ?????????????? ????????, ?? ???? ???????????? ???? ??????????????.
const limiterState = {
  nextAllowedAtMs: 0,
  // ?????????????? ???????????????? ?????????? batchUpdate (????????????????????????????)
  minDelayMs: 1600
}

async function waitForWriteSlot() {
  const nowMs = Date.now()
  const waitMs = Math.max(0, limiterState.nextAllowedAtMs - nowMs)
  if (waitMs > 0) {
    const sleepMsParam = waitMs
    await sleep(sleepMsParam)
  }
}

function markWriteDone() {
  const nowMs = Date.now()
  limiterState.nextAllowedAtMs = nowMs + limiterState.minDelayMs
}

function getRetryAfterMs(e) {
  const headers = e?.response?.headers
  if (!headers) return 0

  // gaxios ?????????? ???????????? ?????????? ?? ???????????? ????????????????
  const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['RETRY-AFTER']
  if (!retryAfterRaw) return 0

  const retryAfterSeconds = Number(retryAfterRaw)
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return 0
  return Math.floor(retryAfterSeconds * 1000)
}

function sanitizeFieldValue(value) {
	if (value === undefined || value === null) return ''

	const text = String(value).trim()
	const cleaned = text.replace(/\{\{\s*[^{}]+\s*\}\}/g, '').trim()
	if (!cleaned || /^\{\{\s*[^{}]+\s*\}$/.test(cleaned)) {
		return ''
	}
	return cleaned
}

function replaceWithDefault(value) {
	const normalized = sanitizeFieldValue(value)
	return normalized || '\u200B'
}

function isYoutubeUrl(value) {
	if (!value) return false
	try {
		const host = new URL(String(value).trim()).hostname.toLowerCase().replace(/^www\./, '')
		return host === 'youtube.com'
			|| host.endsWith('.youtube.com')
			|| host === 'youtu.be'
			|| host === 'youtube-nocookie.com'
			|| host.endsWith('.youtube-nocookie.com')
	} catch {
		return false
	}
}

function parseVideoLinks(value) {
	const text = String(value ?? '').trim()
	if (!text) return { text: '', links: [] }

	const urls = []
	const seen = new Set()
	const matches = text.match(/https?:\/\/[^\s]+/g) || []
	for (let raw of matches) {
		const clean = String(raw).replace(/[),.;!?]+$/g, '')
		if (!clean || seen.has(clean)) continue
		seen.add(clean)
		urls.push(clean)
	}
	if (urls.length) {
		const sortedUrls = urls.filter(isYoutubeUrl)
		if (!sortedUrls.length) return { text: '', links: [] }

		let offset = 0
		const links = sortedUrls.map(url => {
			const start = offset
			const end = start + url.length
			offset = end + 1
			return { url, start, end }
		})
		return { text: sortedUrls.join('\n'), links }
	}
	return { text: '', links: [] }
}

function stripUrls(value) {
	return String(value ?? '')
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '$1')
		.replace(/https?:\/\/\S+/gi, '')
		.replace(/(?:^|\s)www\.\S+/gi, ' ')
		.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/gi, '')
		.replace(/\|\|/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function formatFactsForSlide(value) {
	const text = String(value ?? '').replace(/\r/g, '').trim()
	if (!text) return ''

	const lines = text
		.split('\n')
		.map(s => s.trim())
		.filter(Boolean)

	const outLines = []

	for (const rawLine of lines) {
		const line = rawLine.replace(/^[•*\-\u2022]+\s*/, '').trim()
		if (!line) continue

		let fact = stripUrls(line)
		if (line.includes('||')) {
			const [factPart] = line.split('||')
			fact = stripUrls(factPart)
		} else {
			const firstUrlMatch = line.match(/https?:\/\/\S+/i)
			if (firstUrlMatch) {
				fact = stripUrls(line.replace(firstUrlMatch[0], ' '))
			}
		}

		if (!fact) continue
		outLines.push(`• ${fact}`)
	}

	return outLines.join('\n')
}

function formatTalkingPointsForSlide(value) {
	const text = String(value ?? '').replace(/\r/g, '').trim()
	if (!text) return ''

	const points = text
		.split(/\n\s*\n/g)
		.map(s => s.trim())
		.filter(Boolean)

	const out = []
	for (const rawPoint of points) {
		const point = stripUrls(rawPoint)
			.replace(/^[•*\-\u2022]+\s*/, '')
			.replace(/^\d+[.)]\s*/, '')
			.trim()
		if (!point) continue
		out.push(`- ${point}`)
	}

	return out.join('\n')
}

function buildReplaceMap({ titleWithSource, summary, videosText, sqk, priority }) {
	return {
		'{{title}}': replaceWithDefault(titleWithSource),
		'{{summary}}': replaceWithDefault(summary),
		'{{videos}}': replaceWithDefault(videosText),
		'{{sqk}}': replaceWithDefault(sqk),
		'{{priority}}': replaceWithDefault(priority),
	}
}

function buildReplaceRequests(replaceMap, newSlideId) {
	return Object.entries(replaceMap).map(([key, value]) => ({
		replaceAllText: {
			containsText: { text: key },
			replaceText: String(value ?? ''),
			pageObjectIds: [newSlideId],
		},
	}))
}

function buildCellLinkRequest({ tableId, cell, startIndex, endIndex, url }) {
	if (!cell || !url || endIndex <= startIndex) return null
	return {
		updateTextStyle: {
			fields: 'link',
			objectId: tableId,
			cellLocation: {
				rowIndex: cell.rowIndex,
				columnIndex: cell.columnIndex,
			},
			textRange: {
				type: 'FIXED_RANGE',
				startIndex,
				endIndex,
			},
			style: {
				link: { url },
			},
		},
	}
}

function buildVideoLinkRequests({ tableId, videosCell, links }) {
	if (!videosCell || !Array.isArray(links) || !links.length) return []
	return links.map(link => ({
		updateTextStyle: {
			fields: 'link',
			objectId: tableId,
			cellLocation: {
				rowIndex: videosCell.rowIndex,
				columnIndex: videosCell.columnIndex,
			},
			textRange: {
				type: 'FIXED_RANGE',
				startIndex: link.start,
				endIndex: link.end,
			},
			style: {
				link: { url: link.url },
			},
		},
	}))
}

function resolveArgumentsCell(templatePlaceholderCells) {
	let explicit = templatePlaceholderCells?.['{{arguments}}']
	if (explicit) return { ...explicit, clearBeforeInsert: true }

	let factsCell = templatePlaceholderCells?.['{{notes}}']
	if (!factsCell) return null

	let rowIndex = Number(factsCell.rowIndex)
	let columnIndex = Number(factsCell.columnIndex)
	if (!Number.isFinite(rowIndex) || !Number.isFinite(columnIndex)) return null

	let targetRow = rowIndex + 1
	let rowCount = Number(templatePlaceholderCells?.__meta?.rowCount || 0)
	if (!Number.isFinite(rowCount) || targetRow >= rowCount) return null

	let rowColumnCounts = templatePlaceholderCells?.__meta?.rowColumnCounts
	let targetRowCols = Number(Array.isArray(rowColumnCounts) ? rowColumnCounts[targetRow] : 0)
	if (!Number.isFinite(targetRowCols) || columnIndex >= targetRowCols) return null

	return {
		rowIndex: targetRow,
		columnIndex,
		// Fallback row (below {{notes}}) can be truly empty in template.
		// deleteText(type=ALL) on an empty cell fails in Slides API.
		clearBeforeInsert: false,
	}
}

function buildTableCellTextRequests({ tableId, cell, text, clearBeforeInsert = true }) {
	if (!tableId || !cell) return []
	let normalized = replaceWithDefault(text)
	let requests = []
	if (clearBeforeInsert) {
		requests.push({
			deleteText: {
				objectId: tableId,
				cellLocation: {
					rowIndex: cell.rowIndex,
					columnIndex: cell.columnIndex,
				},
				textRange: { type: 'ALL' },
			},
		})
	}
	requests.push(
		{
			insertText: {
				objectId: tableId,
				cellLocation: {
					rowIndex: cell.rowIndex,
					columnIndex: cell.columnIndex,
				},
				insertionIndex: 0,
				text: normalized,
			},
		},
		{
			updateTextStyle: {
				fields: 'link',
				objectId: tableId,
				cellLocation: {
					rowIndex: cell.rowIndex,
					columnIndex: cell.columnIndex,
				},
				textRange: { type: 'ALL' },
				style: { link: null },
			},
		},
	)
	return requests
}

function isRateLimitError(e) {
  const status = e?.response?.status ?? e?.status
  const reason = e?.errors?.[0]?.reason
  return status === 429 || reason === 'rateLimitExceeded'
}

function jitterMs(maxJitterMs) {
  const maxParam = maxJitterMs
  return Math.floor(Math.random() * maxParam)
}

async function initialize() {
	const slidesVersionParam = 'v1'
	const authParam = auth
	const slidesInitParams = { version: slidesVersionParam, auth: authParam }

	slides = await Slides.slides(slidesInitParams)

	const activeName = activePresentationName()
	const rootFolderIdParam = rootFolderId
	const fileNameParam = activeName
	const existingFile = await getFile(rootFolderIdParam, fileNameParam)

	presentationId = existingFile?.id
}
let init = initialize()

export async function archivePresentation(name) {
  await init
  if (!presentationId) return

	log('Archiving presentation...')
	const fileIdParam = presentationId
	const targetFolderIdParam = activeArchiveFolderId()
	const newNameParam = name

  await moveFile(fileIdParam, targetFolderIdParam, newNameParam)
  presentationId = null
	return fileIdParam
}

export async function archiveCurrentPresentationSnapshot(name = currentRunTag()) {
	await init
	if (!presentationId) return
	let activeName = activePresentationName()
	if (!activeName) return
	let snapshotName = `${name}_${activeName}`
	log('Archiving current presentation snapshot...', snapshotName)
	let copied = await copyFile(presentationId, activeArchiveFolderId(), snapshotName)
	return copied?.id
}

export async function presentationExists() {
  await init
  return presentationId
}

export async function createPresentation() {
	await init
	if (!presentationId) {
		const presentationName = activePresentationName()
		if (!presentationName) {
			throw new Error('Missing presentation name for current run mode')
		}
		const existingFile = await getFile(rootFolderId, presentationName)
		if (existingFile?.id) {
			presentationId = existingFile.id
			return presentationId
		}

		log('Creating presentation...\n')

		const srcFileIdParam = templatePresentationId
		const dstFolderIdParam = rootFolderId
		const dstNameParam = presentationName

		const copied = await copyFile(srcFileIdParam, dstFolderIdParam, dstNameParam)
		presentationId = copied.id
	}
	return presentationId
}

async function batchUpdateWithRetry(requests) {
	const maxAttempts = 6
	let backoffMs = 2000

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await waitForWriteSlot()
			await slides.presentations.batchUpdate({
				presentationId,
				requestBody: { requests },
			})
			markWriteDone()
			return
		} catch (e) {
			log(e)
			if (!isRateLimitError(e)) throw e
			const retryAfterMs = getRetryAfterMs(e)
			const jitterParam = 500
			const delayMs = Math.max(retryAfterMs, backoffMs) + jitterMs(jitterParam)
			await sleep(delayMs)
			backoffMs = Math.min(backoffMs * 2, 120000)
			limiterState.minDelayMs = Math.min(Math.max(limiterState.minDelayMs, 1600) + 250, 5000)
		}
	}

	throw new Error('Could not update slides: persistent rate limit (429).')
}

export async function clearUnfilledCardPlaceholders(placeholders) {
	let provided = Array.isArray(placeholders)
		? placeholders.map(v => String(v || '').trim()).filter(Boolean)
		: []
	let discovered = await findUnfilledCategoryCardTargets()
	let allPlaceholders = [...new Set([...provided, ...discovered.placeholders])]
	let requests = []

	for (let text of allPlaceholders) {
		requests.push({
			replaceAllText: {
				containsText: { text },
				replaceText: '\u200B',
			},
		})
	}
	for (let objectId of discovered.shapeObjectIds) {
		requests.push({
			deleteObject: { objectId },
		})
	}
	if (!requests.length) {
		return { placeholdersCleared: 0, cardsDeleted: 0 }
	}
	await batchUpdateWithRetry(requests)
	return {
		placeholdersCleared: allPlaceholders.length,
		cardsDeleted: discovered.shapeObjectIds.length,
	}
}

export async function addSlide(event) {
  await init

  // ???? ???????????? ????????????: ???????? ?????????????????????? ?????? ??????, ??????????????
  const createdPresentationId = await createPresentation()
  presentationId = createdPresentationId
  const currentSlidesCount = await resolveCurrentSlidesCount()

  const newSlideId = 's' + nanoid()
  const newTableId = 't' + nanoid()

  const title = `${event.titleRu || event.titleEn || ''}`
  const linkUrl = event.usedUrl || event.directUrl || event.url || ''
  const titleWithSource = [title, linkUrl].filter(Boolean).join('\n')
  const videosPayload = parseVideoLinks(event.videoUrls)
  const talkingPointsText = formatTalkingPointsForSlide(event.arguments)
  const factsText = formatFactsForSlide(event.factsRu || event.notes)
  const factsCellText = factsText ? `Факты:\n${factsText}` : ''
  const argumentsCellText = talkingPointsText ? `Аргументы:\n${talkingPointsText}` : ''

  const replaceMap = buildReplaceMap({
    titleWithSource,
    summary: event.summary,
    videosText: videosPayload.text,
    sqk: event.sqk,
    priority: event.priority,
  })

  // ??????????:
  // 1) ?????????????? duplicateObject ?? ?????????????????? templateTableId -> newTableId
  // 2) ?????????? updateTextStyle ???? newTableId
  // 3) updateSlidesPosition ???????????? ?????????????? newSlideId, ?? ???? templateSlideId
  const templateSlideObjectId = await resolveTemplateSlideId()
  const templateTableObjectId = await resolveTemplateTableId()
  const templatePlaceholderCells = await resolveTemplatePlaceholderCells()
  const templateNotesTextShapeObjectIds = await resolveTemplateNotesTextShapeIds()
  const newNotesShapeIds = (templateNotesTextShapeObjectIds || []).map(() => 'n' + nanoid())

  const baseSlidesCount = Number(resolvedTemplateSlidesCount || 0)
  const sqkNumber = Number(event.sqk || 0)
  const desiredInsertionIndex = (Number.isFinite(baseSlidesCount) && Number.isFinite(sqkNumber) && sqkNumber >= 3)
    ? baseSlidesCount + (sqkNumber - 3)
    : Math.max(0, baseSlidesCount || 0)
  const insertionIndex = Math.max(
    0,
    Math.min(
      Number.isFinite(desiredInsertionIndex) ? desiredInsertionIndex : 0,
      Number.isFinite(currentSlidesCount) ? currentSlidesCount : 0
    )
  )

  const objectIds = {
    [templateSlideObjectId]: newSlideId,
    [templateTableObjectId]: newTableId
  }
  for (let i = 0; i < (templateNotesTextShapeObjectIds || []).length; i++) {
    objectIds[templateNotesTextShapeObjectIds[i]] = newNotesShapeIds[i]
  }
  const titleCell = templatePlaceholderCells?.['{{title}}'] || null
  const videosCell = templatePlaceholderCells?.['{{videos}}'] || null
  const factsCell = templatePlaceholderCells?.['{{notes}}'] || null
  const argumentsCell = resolveArgumentsCell(templatePlaceholderCells)
  const titleLinkStart = title ? title.length + 1 : 0
  const titleLinkEnd = titleLinkStart + linkUrl.length
  const titleLinkRequest = buildCellLinkRequest({
    tableId: newTableId,
    cell: titleCell,
    startIndex: titleLinkStart,
    endIndex: titleLinkEnd,
    url: linkUrl,
  })
  const videoLinkRequests = buildVideoLinkRequests({
    tableId: newTableId,
    videosCell,
    links: videosPayload.links,
  })
  const factsCellRequests = buildTableCellTextRequests({
    tableId: newTableId,
    cell: factsCell,
    text: factsCellText,
    clearBeforeInsert: true,
  })
  const argumentsCellRequests = buildTableCellTextRequests({
    tableId: newTableId,
    cell: argumentsCell,
    text: argumentsCellText,
    clearBeforeInsert: argumentsCell?.clearBeforeInsert !== false,
  })
  if (!argumentsCell && argumentsCellText) {
    log('SLIDES arguments cell not found; skipped arguments placement', `sqk=${event.sqk ?? ''}`)
  }

  const requests = [
    {
      duplicateObject: {
        objectId: templateSlideObjectId,
        objectIds: {
          ...objectIds
        }
      }
    },
    ...(newNotesShapeIds.length ? (() => {
      const out = []
      for (let i = 0; i < newNotesShapeIds.length; i++) {
        const objectId = newNotesShapeIds[i]
        out.push({
          deleteText: {
            objectId,
            textRange: { type: 'ALL' }
          }
        })
        out.push({
          insertText: {
            objectId,
            insertionIndex: 0,
            text: '\u200B'
          }
        })
      }
      return out
    })() : []),
    ...buildReplaceRequests(replaceMap, newSlideId),
		...(titleLinkRequest ? [titleLinkRequest] : []),
		...videoLinkRequests,
		...factsCellRequests,
		...argumentsCellRequests,
    {
      replaceAllText: {
        containsText: { text: `{{cat${event.topicId}_card${event.topicSqk}}}` },
        replaceText: String(`${event.sqk ?? ''} ${title}`),
        // ?????? pageObjectIds: ?????????????????? ?????????? ?????????????????/???????????????????????, ???????? ???? ???????? ?? ??????????????????????
      }
    },
    {
      updateSlidesPosition: {
        slideObjectIds: [newSlideId],
        insertionIndex
      }
    }
  ]

  await batchUpdateWithRetry(requests)
}

if (process.argv[1].endsWith('google-slides')) {
  // ?????????? ?????????? ???????????????? ?????????????? ?????? ??????????????????????????
}
