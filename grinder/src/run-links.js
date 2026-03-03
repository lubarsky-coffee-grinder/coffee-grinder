import fs from 'fs'

import { log } from './log.js'

function sanitizeTag(value) {
	return String(value || '')
		.trim()
		.replace(/[^0-9A-Za-z._-]/g, '_')
}

function fallbackTag() {
	let d = new Date()
	let pad = n => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

export function currentRunTag() {
	let envTag = sanitizeTag(process.env.RUN_TAG)
	if (envTag) return envTag
	return fallbackTag()
}

export function runLinksFilePath() {
	return `logs/run-links-${currentRunTag()}.txt`
}

function latestRunLinksFilePath() {
	return 'logs/run-links-latest.txt'
}

let initialized = false

function initRunLinksLog() {
	if (initialized) return
	initialized = true
	try {
		fs.mkdirSync('logs', { recursive: true })
		let path = runLinksFilePath()
		let header = `RUN_TAG=${currentRunTag()} FILE=${path}`
		log(header)
		fs.appendFileSync(path, `${header}\n`, 'utf8')
		fs.writeFileSync(latestRunLinksFilePath(), `${header}\n`, 'utf8')
	} catch {}
}

export function folderLink(id) {
	let value = String(id || '').trim()
	if (!value) return ''
	return `https://drive.google.com/drive/folders/${value}`
}

export function presentationLink(id) {
	let value = String(id || '').trim()
	if (!value) return ''
	return `https://docs.google.com/presentation/d/${value}/edit`
}

export function recordRunLink(label, url) {
	let safeLabel = String(label || '').trim()
	let safeUrl = String(url || '').trim()
	if (!safeLabel || !safeUrl) return
	initRunLinksLog()
	let line = `LINK ${safeLabel}: ${safeUrl}`
	log(line)
	try {
		fs.appendFileSync(runLinksFilePath(), `${line}\n`, 'utf8')
		fs.appendFileSync(latestRunLinksFilePath(), `${line}\n`, 'utf8')
	} catch {}
}
