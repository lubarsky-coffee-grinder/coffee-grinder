import { news, spreadsheetId } from './store.js'
import { archivePresentation } from './google-slides.js'
import { sleep } from './sleep.js'
import { copyFile, getFile, moveFile } from './google-drive.js'
import { rootFolderId, archiveFolderId, autoArchiveFolderId, audioFolderName, imageFolderName } from '../config/google-drive.js'
import { log } from './log.js'
import { recordRunLink, folderLink, presentationLink } from './run-links.js'

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
