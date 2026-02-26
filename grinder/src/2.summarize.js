import fs from 'fs'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { news, save } from './store.js'
import { topics, topicsMap, normalizeTopic } from '../config/topics.js'
// import { restricted } from '../config/agencies.js'
import { decodeGoogleNewsUrl } from './google-news.js'
import { extractArticleInfo, findAlternativeArticles } from './newsapi.js'
import { ai } from './ai.js'
import { collectFacts, collectVideos, collectTitleByUrl, describeFactsSettings, describeVideosSettings, describeTitleLookupSettings } from './enrich.js'
import { extractFallbackKeywords, describeFallbackKeywordsSettings } from './fallback-keywords.js'
import { logRunApiStats, logRunTotalCost } from './cost.js'
import { ensureSummaryAttribution } from './summary-attribution.js'

const MIN_TEXT_LENGTH = 400
const MAX_TEXT_LENGTH = 30000
const FALLBACK_MAX_KEYWORDS = 20

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'over', 'under',
	'about', 'after', 'before', 'between', 'while', 'where', 'when', 'what', 'which', 'whose',
	'of', 'in', 'on', 'at', 'to', 'as', 'by', 'via', 'per', 'than',
	'also', 'other', 'more', 'most', 'some', 'than', 'then', 'they', 'them', 'their', 'there',
	'you', 'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its', 'it', 'are', 'was', 'were',
	'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'not', 'but', 'have', 'has',
	'had', 'been', 'being', 'new', 'news', 'latest', 'update', 'live', 'video', 'watch', 'read',
	'world', 'us', 'usa', 'uk', 'eu',
])

function uniq(list) {
	let seen = new Set()
	let out = []
	for (let v of list) {
		if (!v) continue
		if (seen.has(v)) continue
		seen.add(v)
		out.push(v)
	}
	return out
}

function maybeSingularize(s) {
	if (s.endsWith('s') && s.length > 4 && !s.endsWith('ss')) return s.slice(0, -1)
	return s
}

function urlKeywords(articleUrl, limit = FALLBACK_MAX_KEYWORDS) {
	let u
	try {
		u = new URL(articleUrl)
	} catch {
		return []
	}

	let raw = u.pathname.split('/').filter(Boolean).join('-')
	if (!raw) return []

	raw = raw.replace(/\.[a-z]{2,5}$/i, '')

	let tokens = raw
		.split(/[^A-Za-z0-9]+/g)
		.map(s => s.toLowerCase())
		.filter(s => s.length >= 3)
		.map(maybeSingularize)
		.filter(s => !STOPWORDS.has(s))
		.filter(s => !/^\d+$/.test(s))

	return uniq(tokens).slice(0, limit)
}

function countKeywordHits(haystack, keywords) {
	let h = String(haystack || '').toLowerCase()
	let hits = 0
	for (let k of keywords || []) {
		if (!k) continue
		if (h.includes(k.toLowerCase())) hits++
	}
	return hits
}

function normalizeHttpUrl(value) {
	if (!value) return ''
	try {
		let u = new URL(String(value).trim())
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
		return u.toString()
	} catch {
		return ''
	}
}

function parseUrlLines(value) {
	return String(value ?? '')
		.replace(/\r/g, '\n')
		.split(/\n|,/g)
		.map(v => normalizeHttpUrl(v))
		.filter(Boolean)
}

function mergeUrlLines(existingValue, nextUrls) {
	let merged = uniq([
		...parseUrlLines(existingValue),
		...(nextUrls || []).map(v => normalizeHttpUrl(v)).filter(Boolean),
	])
	return merged.join('\n')
}

function ensureColumns(table, cols) {
	table.headers ||= []
	for (let c of cols) {
		if (!table.headers.includes(c)) table.headers.push(c)
	}
}

function normalizeText(text) {
	return String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

function hasMeaningfulText(value) {
	let text = String(value ?? '')
		.replace(/\u200B/g, '')
		.trim()
	if (!text) return false
	if (/^\{\{\s*[^{}]+\s*\}\}$/.test(text)) return false
	return true
}

function hasVideoLinks(value) {
	return normalizeVideoUrls(value).length > 0
}

function isHttpUrl(value) {
	if (!value) return false
	try {
		let url = new URL(String(value).trim())
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

function isYoutubeUrl(value) {
	if (!isHttpUrl(value)) return false
	try {
		let host = new URL(String(value).trim()).hostname.toLowerCase().replace(/^www\./, '')
		return host === 'youtube.com'
			|| host.endsWith('.youtube.com')
			|| host === 'youtu.be'
			|| host === 'youtube-nocookie.com'
			|| host.endsWith('.youtube-nocookie.com')
	} catch {
		return false
	}
}

function isDirectYoutubeVideoUrl(value) {
	if (!isYoutubeUrl(value)) return false
	try {
		let u = new URL(String(value).trim())
		let host = u.hostname.toLowerCase().replace(/^www\./, '')
		if (host === 'youtu.be') {
			let id = String(u.pathname || '').replace(/^\/+/, '').split('/')[0]
			return !!id
		}
		if (!(host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com'))) return false
		if (u.pathname === '/watch') return !!u.searchParams.get('v')
		if (/^\/embed\/[^/?#]+/.test(u.pathname)) return true
		if (/^\/shorts\/[^/?#]+/.test(u.pathname)) return true
		if (/^\/live\/[^/?#]+/.test(u.pathname)) return true
		return false
	} catch {
		return false
	}
}

function normalizeVideoUrls(value) {
	let text = String(value ?? '').trim()
	if (!text) return ''
	let matches = text.match(/https?:\/\/[^\s]+/g) || []
	let urls = uniq(
		matches
			.map(u => String(u).replace(/[),.;!?]+$/g, '').trim())
			.filter(isDirectYoutubeVideoUrl)
	)
	return urls.join('\n')
}

function normalizeFactsValue(value) {
	let raw = String(value ?? '')
		.replace(/\r/g, '')
		.trim()
	if (!raw) return ''

	let rows = raw
		.split('\n')
		.map(s => s.trim())
		.filter(Boolean)

	let out = []
	for (let row of rows) {
		let line = row.replace(/^[•*\-\u2022]+\s*/, '').trim()
		if (!line) continue

		if (line.includes('||')) {
			line = String(line.split('||')[0] ?? '').trim()
		}
		line = line
			.replace(/https?:\/\/\S+/gi, '')
			.replace(/\s+/g, ' ')
			.trim()
		if (!line) continue
		out.push(line)
	}

	return out.join('\n').trim()
}

function escapeHtml(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

function wrapHtml({ url, html, text }) {
	if (html) {
		return `<!--\n${url}\n-->\n${html}`
	}
	if (text) {
		return `<!--\n${url}\n-->\n<pre>${escapeHtml(text)}</pre>`
	}
	return `<!--\n${url}\n-->`
}

function missingProcessingFields(e) {
	let missing = []
	if (!hasMeaningfulText(e.summary)) missing.push('summary')
	if (!hasMeaningfulText(e.factsRu)) missing.push('factsRu')
	if (!hasVideoLinks(e.videoUrls)) missing.push('videoUrls')
	if (!hasMeaningfulText(e.usedUrl)) missing.push('usedUrl')
	return missing
}

function processingDecision(e) {
	if (e.topic === 'other') {
		return { shouldProcess: false, reason: 'topic=other', missing: [] }
	}
	let missing = missingProcessingFields(e)
	if (!missing.length) {
		return { shouldProcess: false, reason: 'already_complete', missing: [] }
	}
	return {
		shouldProcess: true,
		reason: `needs=${missing.join(',')}`,
		missing,
	}
}

function collectDuplicateUrlGroups(rows) {
	let grouped = new Map()
	for (let e of rows || []) {
		let key = normalizeHttpUrl(e.usedUrl || e.url)
		if (!key) continue
		let bucket = grouped.get(key)
		if (!bucket) {
			bucket = []
			grouped.set(key, bucket)
		}
		bucket.push(e)
	}
	return [...grouped.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([url, group], idx) => ({ groupId: idx + 1, url, group }))
}

function markDuplicateUrls(rows) {
	for (let e of rows || []) {
		e.duplicateUrl = ''
	}

	let groups = collectDuplicateUrlGroups(rows)
	for (let g of groups) {
		let peerIds = uniq(g.group.map(e => String(e.id || '').trim()).filter(Boolean))
		let mark = `DUP_URL group=${g.groupId}; count=${g.group.length}; peer_ids=${peerIds.join(',')}; key=${g.url}`
		for (let e of g.group) {
			e.duplicateUrl = mark
		}
	}
	return groups
}

async function extractVerified(url) {
	for (let attempt = 0; attempt < 2; attempt++) {
		log(`Extract attempt ${attempt + 1}/2...`)
		let info = await extractArticleInfo(url)
		let text = normalizeText(info?.body)
		if (text.length > MIN_TEXT_LENGTH) {
			return {
				url,
				title: info?.title,
				text: text.slice(0, MAX_TEXT_LENGTH),
				html: info?.bodyHtml,
			}
		}
		if (attempt === 0) log('No text extracted, retrying...')
	}
}

async function decodeWithThrottle(last, gnUrl, label = 'Decoding URL...') {
	await sleep(last.urlDecode.time + last.urlDecode.delay - Date.now())
	last.urlDecode.delay += last.urlDecode.increment
	last.urlDecode.time = Date.now()
	log(label)
	return await decodeGoogleNewsUrl(gnUrl)
}

async function tryOtherAgencies(e, primaryUrl) {
	let sourceUrl = normalizeHttpUrl(primaryUrl || e.url)
	if (!sourceUrl) return

	let keywordsAll = urlKeywords(sourceUrl, FALLBACK_MAX_KEYWORDS)
	let keywords = keywordsAll.filter(k => k.length >= 4)
	if (keywords.length < 2) keywords = keywordsAll
	if (!keywords.length) {
		log('No URL keywords for fallback search')
		return
	}

	log(`Fallback URL keywords (${keywords.length}):`, keywords.join(' '))
	log('Extracting fallback keywords...', describeFallbackKeywordsSettings())
	let aiKeywords = await extractFallbackKeywords(sourceUrl, keywords, 8)
	if (aiKeywords.length) log(`Fallback AI keywords (${aiKeywords.length}):`, aiKeywords.join(' '))
	let searchKeywords = aiKeywords.length ? aiKeywords : keywords
	log(`Fallback search keywords (${searchKeywords.length}):`, searchKeywords.join(' '))

	let candidates = await findAlternativeArticles(sourceUrl, { keywords: searchKeywords })
	if (!candidates.length) {
		log('No alternative articles found')
		return
	}
	const currentUrl = sourceUrl
	const alternativeUrls = uniq(
		candidates
			.map(a => normalizeHttpUrl(a?.url))
			.filter(Boolean)
			.filter(url => !currentUrl || url !== currentUrl)
	)
	if (alternativeUrls.length) {
		e.alternativeUrls = mergeUrlLines(e.alternativeUrls, alternativeUrls)
		log('Saved alternative URLs:', alternativeUrls.length)
	}

	log('Found', candidates.length, 'alternative candidates')
	let baseSource = (e.source || '').trim().toLowerCase()
	let baseHost = ''
	try { baseHost = new URL(sourceUrl).hostname } catch {}
	let keywordsForMatch = keywords
	if (keywordsForMatch.length) log('Fallback relevance keywords:', keywordsForMatch.join(' '))

	let minMatchHits = Math.min(2, keywordsForMatch.length)
	let maxTries = 7
	let tries = 0

	for (let a of candidates) {
		if (tries >= maxTries) break
		let url = a?.url
		if (!url || url === sourceUrl) continue
		if (baseSource && a.source && a.source.trim().toLowerCase() === baseSource) continue
		if (baseHost) {
			try {
				if (new URL(url).hostname === baseHost) continue
			} catch {}
		}
		let meta = `${a?.title || ''}\n${url}`
		let metaHits = countKeywordHits(meta, searchKeywords)
		let eventUri = a?.eventUri

		log(
			'Trying fallback candidate',
			a.source || '',
			eventUri ? `eventUri=${eventUri}` : '',
			`metaHits=${metaHits}/${searchKeywords.length}`,
			`url=${url}`,
		)
		tries++

		log('Extracting fallback', a.source || '', 'article...')
		let extracted = await extractVerified(url)
		if (extracted) {
			if (keywordsForMatch.length) {
				let title = extracted.title || ''
				let haystack = `${title}\n${extracted.text || ''}`
				let totalHits = countKeywordHits(haystack, keywordsForMatch)
				if (totalHits < minMatchHits) {
					log('Skipping fallback (low relevance)', a.source || '', `hits=${totalHits}/${keywordsForMatch.length} total`, `url=${url}`)
					continue
				}
			}
			return extracted
		}
	}
}

export async function summarize() {
	ensureColumns(news, ['date', 'url', 'usedUrl', 'alternativeUrls', 'factsRu', 'videoUrls', 'duplicateUrl'])

	news.forEach((e, i) => e.id ||= i + 1)

	let rows = news.map((e, rowIndex) => {
		let decision = processingDecision(e)
		let dedupeKey = normalizeHttpUrl(e.usedUrl || e.url)
		if (!dedupeKey && e.gnUrl) dedupeKey = String(e.gnUrl).trim()
		return { e, rowIndex, dedupeKey, ...decision }
	})
	let runRows = rows.filter(row => row.shouldProcess)
	for (let i = 0; i < runRows.length; i++) {
		runRows[i].runIndex = i + 1
	}
	let firstRunIndexByDedupeKey = new Map()
	for (let row of runRows) {
		if (!row.dedupeKey) continue
		let firstRunIndex = firstRunIndexByDedupeKey.get(row.dedupeKey)
		if (firstRunIndex != null) {
			row.skipReason = `duplicate_of_row=${firstRunIndex}`
			continue
		}
		firstRunIndexByDedupeKey.set(row.dedupeKey, row.runIndex)
	}
	let list = runRows.filter(row => !row.skipReason)
	let skipped = runRows.filter(row => !!row.skipReason)
	log(
		'SUMMARIZE_ROWS',
		`total=${runRows.length}`,
		`to_process=${list.length}`,
		`skipped=${skipped.length}`,
	)
	let skippedByReason = {}
	for (let row of skipped) {
		skippedByReason[row.skipReason] = (skippedByReason[row.skipReason] || 0) + 1
		let title = row.e.titleEn || row.e.titleRu || ''
		log(
			`\n#${row.runIndex} [${row.runIndex}/${runRows.length}] SKIP`,
			`reason=${row.skipReason}`,
			title,
		)
	}
	let skippedReasonParts = Object.entries(skippedByReason)
		.map(([reason, count]) => `${reason}=${count}`)
	if (skippedReasonParts.length) {
		log('SUMMARIZE_SKIP_REASONS', ...skippedReasonParts)
	}

	let stats = { ok: 0, fail: 0 }
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
		facts: { time: 0, delay: 0 },
		videos: { time: 0, delay: 0 },
	}
	for (let i = 0; i < list.length; i++) {
		let row = list[i]
		let e = row.e
		log(
			`\n#${row.runIndex} [${row.runIndex}/${runRows.length}]`,
			`work=${i + 1}/${list.length}`,
			`reason=${row.reason}`,
			e.titleEn || e.titleRu || '',
		)
		let articleText = ''
		let sourceUrl = normalizeHttpUrl(e.url)

		if (!sourceUrl /*&& !restricted.includes(e.source)*/) {
			if (!e.gnUrl) {
				log('SKIP processing: missing url and gnUrl')
				stats.fail++
				continue
			}
			sourceUrl = await decodeWithThrottle(last, e.gnUrl)
			if (!sourceUrl) {
				await sleep(5*60e3)
				i--
				continue
			}
			log('got', sourceUrl)
		}
		if (sourceUrl) {
			// Always keep the actually used source URL:
			// start with original URL, then overwrite with fallback URL if selected later.
			e.usedUrl = sourceUrl
		}

		const needsTextWork = !hasMeaningfulText(e.summary) || !hasMeaningfulText(e.factsRu) || !hasVideoLinks(e.videoUrls)
		if (sourceUrl && needsTextWork) {
			log('Extracting', e.source || '', 'article...', `url=${sourceUrl}`)
			let extracted = await extractVerified(sourceUrl)
			if (!extracted) {
				log('Failed to extract article text, trying another agency...')
				extracted = await tryOtherAgencies(e, sourceUrl)
			}
			if (extracted) {
				e.usedUrl = extracted.url || sourceUrl
				log('got', extracted.text.length, 'chars')
				fs.writeFileSync(`articles/${e.id}.html`, wrapHtml(extracted))
				articleText = extracted.text
				fs.writeFileSync(`articles/${e.id}.txt`, `${e.titleEn || e.titleRu || ''}\n\n${articleText}`)
			} else {
				log('Could not extract article text. Trying URL title lookup...', describeTitleLookupSettings())
				try {
					let lookedUp = await collectTitleByUrl({ url: e.usedUrl || sourceUrl || e.url })
					if (lookedUp?.titleEn || lookedUp?.titleRu) {
						e.titleEn ||= lookedUp.titleEn
						e.titleRu ||= lookedUp.titleRu
						log('Title lookup done', `titleEn=${lookedUp.titleEn ? 'yes' : 'no'}`, `titleRu=${lookedUp.titleRu ? 'yes' : 'no'}`)
					} else {
						log('Title lookup failed (empty title)')
					}
					if (lookedUp?.extra) {
						log('Title lookup extra:', lookedUp.extra)
					}
				} catch (err) {
					log('Title lookup failed', err?.message || err)
				}
			}
		}

		const shouldSummarize = articleText.length > 400 && !hasMeaningfulText(e.summary)
		const shouldCollectFacts = articleText.length > MIN_TEXT_LENGTH && !hasMeaningfulText(e.factsRu)
		const shouldCollectVideos = articleText.length > MIN_TEXT_LENGTH && !hasVideoLinks(e.videoUrls)

		if (shouldSummarize || shouldCollectFacts || shouldCollectVideos) {
			let enrichInput = { ...e, url: e.usedUrl || sourceUrl || e.url, text: articleText }
			let tasks = []
			const makeLogger = (task) => (...params) => task.logs.push(params)

				if (shouldSummarize) {
					log('Summarizing', articleText.length, 'chars...')
					let task = {
						name: 'summary',
						logs: [],
						run: async () => {
							await sleep(last.ai.time + last.ai.delay - Date.now())
							last.ai.time = Date.now()
							return await ai({
								url: e.usedUrl || sourceUrl || e.url,
								source: e.source,
								text: articleText,
								logger: makeLogger(task),
							})
						}
					}
					tasks.push(task)
				}

				if (shouldCollectFacts) {
				log('Collecting facts...', describeFactsSettings())
				let task = {
					name: 'facts',
					logs: [],
					run: async () => {
						await sleep(last.facts.time + last.facts.delay - Date.now())
						last.facts.time = Date.now()
						return await collectFacts(enrichInput, { logger: makeLogger(task) })
					}
				}
				tasks.push(task)
			}

			if (shouldCollectVideos) {
				log('Collecting videos...', describeVideosSettings())
				let task = {
					name: 'videos',
					logs: [],
					run: async () => {
						await sleep(last.videos.time + last.videos.delay - Date.now())
						last.videos.time = Date.now()
						return await collectVideos(enrichInput, { logger: makeLogger(task) })
					}
				}
				tasks.push(task)
			}

			if (tasks.length > 1) {
				log('Running in parallel:', tasks.map(t => t.name).join(', '))
			}

			let results = await Promise.allSettled(tasks.map(t => t.run()))
			for (let i = 0; i < tasks.length; i++) {
				let task = tasks[i]
				let result = results[i]

				for (let params of task.logs || []) {
					log(...params)
				}

				if (result.status === 'rejected') {
					log(`${task.name} failed`, result.reason?.message || result.reason || '')
					continue
				}

				if (task.name === 'summary') {
					let res = result.value
					if (res) {
						last.ai.delay = res.delay
						const normalizedTopic = normalizeTopic(topicsMap[res.topic] || res.topic || '')
						let normalizedSummary = ensureSummaryAttribution(res.summary, e)
						e.priority ||= res.priority
						e.titleRu ||= res.titleRu
						e.summary = normalizedSummary
						e.aiTopic = normalizedTopic || topicsMap[res.topic]
						e.aiPriority = res.priority
						if (normalizedSummary !== String(res.summary ?? '').trim()) {
							log('summary attribution appended')
						}
						log('summary done', `${String(normalizedSummary || '').length} chars`)
					} else {
						log('summary failed (empty result)')
					}
					continue
				}

				if (task.name === 'facts') {
					let factsRu = normalizeFactsValue(result.value)
					if (factsRu) {
						e.factsRu = factsRu
						log('facts done', `${factsRu.length} chars`)
					} else {
						log('facts failed (empty result)')
					}
					continue
				}

				if (task.name === 'videos') {
					let videoUrls = normalizeVideoUrls(result.value)
					if (videoUrls) {
						e.videoUrls = videoUrls
						log('videos done', `${videoUrls.length} chars`)
					} else {
						log('videos failed (empty result)')
					}
				}
			}
		}

		if (!e.summary) {
			log('failed to summarize')
			stats.fail++
		} else {
			stats.ok++
		}
	}
	let attributionAutofixCount = 0
	for (let e of news) {
		let fixedSummary = ensureSummaryAttribution(e.summary, e)
		if (!fixedSummary || fixedSummary === String(e.summary ?? '').trim()) continue
		e.summary = fixedSummary
		attributionAutofixCount++
	}
	if (attributionAutofixCount) {
		log('SUMMARY_ATTRIBUTION_AUTOFIX', `updated=${attributionAutofixCount}`)
	}
	let duplicateGroups = markDuplicateUrls(news)
	let duplicateRows = duplicateGroups.reduce((sum, g) => sum + g.group.length, 0)
	log('SUMMARY_DUP_URL', `groups=${duplicateGroups.length}`, `rows=${duplicateRows}`)
	for (let g of duplicateGroups) {
		log(`SUMMARY_DUP_URL group=${g.groupId} count=${g.group.length} url=${g.url}`)
		for (let e of g.group) {
			log(
				'  row',
				`id=${e.id || ''}`,
				`sqk=${e.sqk || ''}`,
				`source=${e.source || ''}`,
				`title=${e.titleRu || e.titleEn || ''}`,
				`url=${normalizeHttpUrl(e.url) || String(e.url || '').trim()}`,
				`usedUrl=${normalizeHttpUrl(e.usedUrl) || String(e.usedUrl || '').trim()}`,
			)
		}
	}
	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))
	await save()

	log('\n', stats)
	logRunTotalCost({ task: 'summarize', logger: log })
	logRunApiStats({ task: 'summarize', logger: log })
}

if (process.argv[1].endsWith('summarize')) summarize()
