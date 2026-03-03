import { log } from './log.js'
import { getFile, moveFile, uploadFolder } from './google-drive.js'
import { rootFolderId, archiveFolderId, autoArchiveFolderId, imageFolderName } from '../config/google-drive.js'
import { recordRunLink, folderLink } from './run-links.js'

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

export async function uploadImg() {
	let tag = runTag()
	let archiveFolder = activeArchiveFolderId()
	recordRunLink('img_live_folder', folderLink(rootFolderId))
	recordRunLink('archive_folder', folderLink(archiveFolder))
	let existing = await getFile(rootFolderId, imageFolderName)
	if (existing?.id) {
		log('Archiving previous images folder...')
		await moveFile(existing.id, archiveFolder, `${tag}_prev_${imageFolderName}`)
		recordRunLink('archive_prev_img', folderLink(existing.id))
	}

	log('Uploading images to Drive...')
	let liveFolderId = await uploadFolder('../img', rootFolderId, imageFolderName, ['.jpg', '.png'])
	if (liveFolderId) {
		recordRunLink('img_current', folderLink(liveFolderId))
	}
	log('Archiving current images snapshot...')
	let archiveSnapshotFolderId = await uploadFolder('../img', archiveFolder, `${tag}_${imageFolderName}`, ['.jpg', '.png'])
	if (archiveSnapshotFolderId) {
		recordRunLink('archive_img_snapshot', folderLink(archiveSnapshotFolderId))
	}
	log('Images uploaded.')
}

if (process.argv[1]?.includes('upload-img')) uploadImg()
