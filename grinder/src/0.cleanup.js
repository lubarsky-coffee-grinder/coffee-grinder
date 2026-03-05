import { news, save } from './store.js'
import { archivePresentation } from './google-slides.js'
import { sleep } from './sleep.js'
import { copyFile, getFile, moveFile } from './google-drive.js'
import { rootFolderId, archiveFolderId, autoArchiveFolderId, audioFolderName, imageFolderName } from '../config/google-drive.js'
import { log } from './log.js'
import { recordRunLink, folderLink, presentationLink } from './run-links.js'

const RESET_COLUMNS = [
	'factsRu',
	'arguments',
	'videoUrls',
	'date',
	'alternativeUrls',
	'usedUrl',
	'duplicateUrl',
]

function ensureColumns(table, cols) {
	table.headers ||= []
	for (let c of cols) {
		if (!table.headers.includes(c)) table.headers.push(c)
	}
}

function normalizeHeaders(table) {
	table.headers ||= []
	let normalized = []
	let seen = new Set()
	for (let raw of table.headers) {
		let key = String(raw ?? '').trim()
		if (!key) continue
		if (key === 'talkingPointsRu') key = 'arguments'
		if (seen.has(key)) continue
		seen.add(key)
		normalized.push(key)
	}
	table.headers = normalized
}

async function clearNewsColumns() {
	normalizeHeaders(news)
	ensureColumns(news, RESET_COLUMNS)
	for (let row of news || []) {
		for (let col of RESET_COLUMNS) row[col] = ''
		// One-time cleanup of old field if it still exists in sheet rows.
		if (Object.prototype.hasOwnProperty.call(row, 'talkingPointsRu')) row.talkingPointsRu = ''
	}
	await save()
	log('Cleanup: cleared table columns', RESET_COLUMNS.join(', '), `rows=${news.length}`)
}

function isAutoRun() {
	return process.argv[2]?.endsWith('auto')
}

function activeArchiveFolderId() {
	return isAutoRun() ? autoArchiveFolderId : archiveFolderId
}

function runTag() {
	let value = String(process.env.RUN_TAG || '').trim()
	if (value) return value
	let d = new Date()
	let pad = n => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

export async function cleanup() {
	let name = runTag()
	let archiveFolder = activeArchiveFolderId()
	recordRunLink('archive_folder', folderLink(archiveFolder))
	await clearNewsColumns()
	//if (news.length) {
	//	log('Archiving spreadsheet...')
	//	await copyFile(spreadsheetId, archiveFolderId, name)
	//	news.forEach((e, i) => news[i] = {})
	//	await sleep(1)
	//	news.length = 0
	//}
	let archivedPresentationId = await archivePresentation(name)
	if (archivedPresentationId) {
		recordRunLink('archive_prev_presentation', presentationLink(archivedPresentationId))
	}
	let audio = await getFile(rootFolderId, audioFolderName)
	if (audio) {
		log('Archiving audio...')
		await moveFile(audio.id, archiveFolder, `${name}_prev_${audioFolderName}`)
		recordRunLink('archive_prev_audio', folderLink(audio.id))
	}
	let image = await getFile(rootFolderId, imageFolderName)
	if (image) {
		log('Archiving images...')
		await moveFile(image.id, archiveFolder, `${name}_prev_${imageFolderName}`)
		recordRunLink('archive_prev_img', folderLink(image.id))
	}
}

if (process.argv[1].endsWith('cleanup')) cleanup()
