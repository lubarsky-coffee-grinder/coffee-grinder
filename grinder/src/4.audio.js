import { log } from './log.js'
import { news } from './store.js'
import { speak } from './eleven.js'
import { getFile, moveFile, uploadFolder } from './google-drive.js'
import { rootFolderId, archiveFolderId, autoArchiveFolderId, audioFolderName } from '../config/google-drive.js'
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

export async function audio() {
	let archiveFolder = activeArchiveFolderId()
	recordRunLink('audio_live_folder', folderLink(rootFolderId))
	recordRunLink('archive_folder', folderLink(archiveFolder))
	let list = news.filter(e => e.sqk && e.summary)
	for (let i = 0; i < list.length; i++) {
		let event = list[i]
		log(`\n[${i + 1}/${list.length}]`, `${event.sqk}. ${event.titleEn || event.titleRu}`)

		if (event.summary) {
			log('Speaking', event.summary.length, 'chars...')
			await speak(event.sqk, event.summary)
		}
	}

	let tag = runTag()
	let existing = await getFile(rootFolderId, audioFolderName)
	if (existing?.id) {
		log('Archiving previous audio folder...')
		await moveFile(existing.id, archiveFolder, `${tag}_prev_${audioFolderName}`)
		recordRunLink('archive_prev_audio', folderLink(existing.id))
	}

	log('\nUploading audio to Drive...')
	let liveFolderId = await uploadFolder('../audio', rootFolderId, audioFolderName, ['.mp3'])
	if (liveFolderId) {
		recordRunLink('audio_current', folderLink(liveFolderId))
	}
	log('Archiving current audio snapshot...')
	let archiveSnapshotFolderId = await uploadFolder('../audio', archiveFolder, `${tag}_${audioFolderName}`, ['.mp3'])
	if (archiveSnapshotFolderId) {
		recordRunLink('archive_audio_snapshot', folderLink(archiveSnapshotFolderId))
	}
	log('Audio uploaded.')
}

if (process.argv[1].endsWith('audio')) audio()
