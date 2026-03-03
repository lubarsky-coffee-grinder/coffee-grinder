import Drive from '@googleapis/drive'
import { createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'

import { log } from './log.js'
import { auth } from './google-auth.js'

async function initialize() {
	return await Drive.drive({ version: 'v3', auth })
}
let init = initialize()

export async function createFolder(folderId, name) {
	let drive = await init
	const file = await drive.files.create({	resource: {
		'parents': [folderId],
		name,
		'mimeType': 'application/vnd.google-apps.folder',
	}})
    return file.data.id
}

export async function getFile(folderId, name) {
	let drive = await init
	let files = (await drive.files.list({
		// Do not return trashed files: E2E cleanup and deck creation rely on existence checks.
		q: `'${folderId}' in parents and trashed = false and name = '${name}'`,
	})).data.files
	return files[0]
}

export async function moveFile(fileId, newFolderId, newName = null) {
	let drive = await init
	const res = await drive.files.get({
		fileId: fileId,
		fields: 'parents, name'
	})
	await drive.files.update({
		fileId: fileId,
		removeParents: res.data.parents,
		addParents: newFolderId,
		resource: {
			name: newName || res.data.name,
		},
	})
}

export async function trashFile(fileId) {
	let drive = await init
	await drive.files.update({
		fileId: fileId,
		resource: { trashed: true },
	})
}

export async function copyFile(fileId, folderId, name) {
	let drive = await init
	let res = await drive.files.copy({
		fileId,
		requestBody: {
			name,
			parents: [folderId],
		},
	})
	return res.data
}

export async function uploadFolder(localPath, parentFolderId, folderName, extensions = null) {
	let drive = await init

	// ???????????????? ???????????? ???????????? ?????? ????????????????
	let allFiles = await readdir(localPath)
	let filesToUpload = allFiles.filter(fileName => {
		if (fileName.startsWith('.')) return false
		if (extensions && !extensions.some(ext => fileName.endsWith(ext))) return false
		return true
	})

	// ???? ?????????????????? ?????????? ???????? ?????? ????????????
	if (filesToUpload.length === 0) {
		log('No files to upload in', localPath)
		return null
	}

	// ?????????? ???????????????????????? ?????????? ?????? ?????????????? ??????????
	let folder = await getFile(parentFolderId, folderName)
	let folderId
	if (folder) {
		folderId = folder.id
		log(`Using existing folder: ${folderName}`)
	} else {
		let created = await drive.files.create({
			resource: {
				name: folderName,
				mimeType: 'application/vnd.google-apps.folder',
				parents: [parentFolderId]
			}
		})
		folderId = created.data.id
		log(`Created new folder: ${folderName}`)
	}
	log('Upload target folder:', `https://drive.google.com/drive/folders/${folderId}`)

	// ?????????????????? ??????????
	for (let fileName of filesToUpload) {
		log(`  Uploading ${fileName}...`)
		await drive.files.create({
			requestBody: {
				name: fileName,
				parents: [folderId]
			},
			media: {
				body: createReadStream(join(localPath, fileName))
			}
		})
	}

	return folderId
}
