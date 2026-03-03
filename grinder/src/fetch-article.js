import { log } from './log.js'

function shortError(e) {
	if (!e) return 'unknown error'
	let message = e?.message || String(e)
	let causeMessage = e?.cause?.message
	if (causeMessage && causeMessage !== message) return `${message}: ${causeMessage}`
	return message
}

export async function fetchArticle(url) {
	for (let i = 0; i < 2; i++) {
		try {
			let response = await fetch(url, {
				signal: AbortSignal.timeout(10e3)
			})
			if (response.ok) {
				return await response.text()
			} else {
				log('article fetch failed', response.status, response.statusText)
				return
			}
		} catch(e) {
			log('article fetch failed', shortError(e))
		}
	}
	// let response
	// if (paywalled.some(u => url.includes(u))) {
	// 	url = 'https://archive.ph/' + url
	// 	log(url)
	// 	response = await fetch(url)
	// } else {
	// 	response = await fetch(url)
	// 	if (!response.ok) {
	// 		log(response.status, response.statusText)
	// 		url = 'https://archive.ph/' + url
	// 		log(url)
	// 		response = await fetch(url)
	// 	}
	// }
	// if (response.ok) {
	// 	return await response.text()
	// } else {
	// 	log('article fetch failed', response.status, response.statusText)
	// }
}
