import { firefox } from 'playwright'
import { readFile } from 'fs/promises'
import { join } from 'path'
import OpenAI from 'openai'
import { log } from './log.js'
import { estimateAndLogCost, logRunTotalCost } from './cost.js'

const IMG_DIR = join(import.meta.dirname, '../../img')
const SCREENSHOTS_FILE = join(IMG_DIR, 'screenshots.txt')

const GOTO_TIMEOUT_MS = 60000
const DOM_READY_TIMEOUT_MS = 15000
const PER_URL_TIMEOUT_MS = 120000
const KNOWN_FIX_PASSES = 2
const VISION_TIMEOUT_MS = 12000

const SAFE_CLICK_TEXTS = [
	'accept all',
	'i accept all',
	'accept',
	'continue with ads',
	'continue with recommended cookies',
	'i agree',
	'agree',
	'allow all',
	'ok',
	'later',
	'принять',
	'принять все',
	'согласен',
	'соглашаюсь',
	'согласиться',
	'akzeptieren',
	'alle akzeptieren',
	'zustimmen',
]

const UNSAFE_CLICK_TEXTS = [
	'subscribe',
	'order',
	'buy',
	'watch tv',
	'watch now',
	'sign in',
	'log in',
	'login',
	'register',
	'trial',
	'manage',
	'settings',
]

const CONSENT_SELECTORS = [
	'#onetrust-accept-btn-handler',
	'[id*="onetrust-accept"]',
	'[class*="onetrust"] button',
	'#didomi-notice-agree-button',
	'[id*="didomi"] button',
	'[class*="didomi"] button',
	'#qc-cmp2-ui button',
	'[id*="qc-cmp2"] button',
	'[class*="qc-cmp2"] button',
	'[id*="truste"] button',
	'[class*="truste"] button',
	'[id*="sp_message"] button',
	'[id^="sp_message_container"] button',
	'[class*="sp_message"] button',
	'[id*="cookie"] button',
	'[class*="cookie"] button',
	'[id*="consent"] button',
	'[class*="consent"] button',
	'[id*="privacy"] button',
	'[class*="privacy"] button',
	'[aria-label*="Accept"]',
	'[title*="Accept"]',
]

const OVERLAY_REMOVE_SELECTORS = [
	'[id*="onetrust"]', '[class*="onetrust"]',
	'[id*="didomi"]', '[class*="didomi"]',
	'[id*="qc-cmp2"]', '[class*="qc-cmp2"]',
	'[id*="truste"]', '[class*="truste"]',
	'[id*="sp_message"]', '[class*="sp_message"]', '[id^="sp_message_container"]',
	'[id*="cookie"]', '[class*="cookie"]',
	'[id*="consent"]', '[class*="consent"]',
	'[id*="gdpr"]', '[class*="gdpr"]',
	'[id*="privacy"]', '[class*="privacy"]',
	'[id*="paywall"]', '[class*="paywall"]',
	'[id*="overlay"]', '[class*="overlay"]',
	'[id*="modal"]', '[class*="modal"]',
	'[aria-modal="true"]', '[role="dialog"]',
]

const OPENAI_SCREENSHOT_MODEL = process.env.OPENAI_SCREENSHOT_MODEL || process.env.OPENAI_FACTS_MODEL || 'gpt-4o-mini'
const ENABLE_VISION_FALLBACK = process.env.SCREENSHOT_GPT_FALLBACK !== '0' && !!process.env.OPENAI_API_KEY
const openai = ENABLE_VISION_FALLBACK ? new OpenAI() : null

function parseUrl(line) {
	return String(line ?? '')
		.split('||')[0]
		.trim()
}

function normalizeText(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim()
}

function isContextDestroyedError(error) {
	const msg = String(error?.message || error || '')
	return msg.includes('Execution context was destroyed')
		|| msg.includes('Cannot find context with specified id')
}

function isDomUnavailableError(error) {
	const msg = String(error?.message || error || '')
	return msg.includes('document.documentElement is null')
		|| msg.includes("can't access property \"clientWidth\"")
		|| msg.includes("can't access property \"style\"")
}

async function waitDom(page, timeout = DOM_READY_TIMEOUT_MS) {
	await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
}

function assertBudget(startedAt, step) {
	if (Date.now() - startedAt > PER_URL_TIMEOUT_MS) {
		throw new Error(`per-url timeout exceeded at step=${step}`)
	}
}

async function withTimeout(promise, ms, label) {
	let timer
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

async function safeEvaluate(page, fn, ...args) {
	let lastError
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await page.evaluate(fn, ...args)
		} catch (e) {
			lastError = e
			if (isContextDestroyedError(e) || isDomUnavailableError(e)) {
				await waitDom(page, 5000)
				await page.waitForTimeout(400)
				continue
			}
			throw e
		}
	}
	throw new Error(`evaluate failed after retries: ${String(lastError?.message || lastError || 'unknown')}`)
}

async function clickByTextInFrame(frame, safeTexts) {
	try {
		return Number(await frame.evaluate((allow, deny) => {
			const normalize = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim()
			const nodes = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')
			let clicked = 0
			for (const node of nodes) {
				const text = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('value'))
				if (!text) continue
				if (deny.some(v => text.includes(v))) continue
				if (!allow.some(v => text.includes(v))) continue
				try {
					node.click()
					clicked++
				} catch {}
			}
			return clicked
		}, safeTexts, UNSAFE_CLICK_TEXTS) || 0)
	} catch {
		return 0
	}
}

async function clickBySelectorInFrame(frame, selectors) {
	try {
		return Number(await frame.evaluate((items) => {
			let clicked = 0
			for (const sel of items) {
				const node = document.querySelector(sel)
				if (!node) continue
				try {
					node.click()
					clicked++
				} catch {}
			}
			return clicked
		}, selectors) || 0)
	} catch {
		return 0
	}
}

async function clickKnownConsentButtons(page) {
	let clicks = 0
	for (const frame of page.frames()) {
		clicks += await clickByTextInFrame(frame, SAFE_CLICK_TEXTS)
		clicks += await clickBySelectorInFrame(frame, CONSENT_SELECTORS)
	}
	if (clicks > 0) await page.waitForTimeout(500)
	return clicks
}

async function removeKnownOverlays(page) {
	return Number(await safeEvaluate(page, (selectors) => {
		if (!document) return 0
		let removed = 0
		for (const sel of selectors) {
			document.querySelectorAll(sel).forEach(el => {
				try {
					el.remove()
					removed++
				} catch {}
			})
		}
		return removed
	}, OVERLAY_REMOVE_SELECTORS) || 0)
}

async function cleanupCosmetic(page) {
	await safeEvaluate(page, () => {
		if (!document || !document.documentElement) return
		const vw = Math.max(window.innerWidth || 0, 1)
		const vh = Math.max(window.innerHeight || 0, 1)

		document.querySelectorAll('*').forEach(el => {
			const style = getComputedStyle(el)
			const isFixed = style.position === 'fixed' || style.position === 'sticky'
			if (!isFixed) return
			const r = el.getBoundingClientRect()
			const coversBigArea = r.width > vw * 0.5 && r.height > vh * 0.2
			const isTallSidebar = r.width > vw * 0.12 && r.height > vh * 0.5
			if (coversBigArea || isTallSidebar) {
				try { el.remove() } catch {}
			}
		})

		if (document.body) document.body.style.overflow = 'auto'
		document.documentElement.style.overflow = 'auto'
	})
}

async function alignToContent(page) {
	await safeEvaluate(page, () => {
		const h1 = document.querySelector('h1')
		if (h1) {
			h1.scrollIntoView({ block: 'start' })
			window.scrollBy(0, -20)
			return
		}
		const anchor = document.querySelector('article, main')
		if (anchor) {
			anchor.scrollIntoView({ block: 'start' })
			window.scrollBy(0, -20)
		}
	})
}

async function inspectPage(page) {
	try {
		return await safeEvaluate(page, () => {
			if (!document || !document.body || !document.documentElement) {
				return {
					ok: false,
					issueType: 'unknown',
					reason: 'document_unavailable',
					hasBlockingOverlay: false,
					hasPrimaryContent: false,
				}
			}

			const headline = (document.querySelector('h1')?.innerText || '').trim()
			const articleText = (document.querySelector('article')?.innerText || document.querySelector('main')?.innerText || '').trim()
			const bodyText = (document.body.innerText || '').trim()
			const scanText = `${headline}\n${bodyText}`.toLowerCase().slice(0, 40000)

			const hasCaptcha = /(captcha|verify you are human|not a robot|security check|access denied|access_denied|unusual traffic|security verification|forbidden|request blocked|attention required|cloudflare|just a moment|bot detection)/i.test(scanText)
			const hasPaywallText = /(subscribe|subscriber|for subscribers|sign in to continue|login to continue|paywall)/i.test(scanText)
			const hasConsentText = /(cookie|consent|privacy settings|we care about your privacy|gdpr|partner)/i.test(scanText)

			const vw = Math.max(window.innerWidth || 0, 1)
			const vh = Math.max(window.innerHeight || 0, 1)
			let hasBlockingOverlay = false
			let overlayText = ''
			document.querySelectorAll('*').forEach(el => {
				if (hasBlockingOverlay) return
				const style = getComputedStyle(el)
				if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
				if (style.position !== 'fixed' && style.position !== 'sticky') return
				const r = el.getBoundingClientRect()
				if (r.width <= 0 || r.height <= 0) return
				const area = (r.width * r.height) / (vw * vh)
				if (area < 0.16) return
				const text = String(el.textContent || '').trim().slice(0, 1200).toLowerCase()
				if (!text) return
				hasBlockingOverlay = true
				overlayText = text
			})

			const hasPrimaryContent =
				((headline.length > 20) && (articleText.length > 80 || bodyText.length > 800))
				|| articleText.length > 500
				|| bodyText.length > 2200

			let issueType = 'none'
			if (hasCaptcha) issueType = 'captcha'
			else if (hasBlockingOverlay && /(cookie|consent|privacy|gdpr|partner|accept|agree)/i.test(overlayText)) issueType = 'consent'
			else if (hasPaywallText && !hasPrimaryContent) issueType = 'paywall'
			else if (hasBlockingOverlay) issueType = 'overlay'
			else if (!hasPrimaryContent) issueType = 'unknown'

			const ok = hasPrimaryContent && !hasBlockingOverlay && !hasCaptcha
			let reason = ok ? 'content_visible' : issueType
			if (!ok && hasConsentText && issueType === 'unknown') reason = 'consent_like_unknown'

			return {
				ok,
				issueType,
				reason,
				hasBlockingOverlay,
				hasPrimaryContent,
			}
		})
	} catch (e) {
		return {
			ok: false,
			issueType: 'unknown',
			reason: `inspect_error: ${String(e?.message || e)}`,
			hasBlockingOverlay: false,
			hasPrimaryContent: false,
		}
	}
}

function extractJson(text) {
	if (!text) return null
	let raw = String(text).trim()
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	if (fenced?.[1]) raw = fenced[1]
	const objectMatch = raw.match(/\{[\s\S]*\}/)
	if (objectMatch) raw = objectMatch[0]
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

function shouldUseVisionFallback(check) {
	if (!ENABLE_VISION_FALLBACK || !openai) return false
	if (check?.ok) return false
	if (check?.issueType === 'captcha') return false
	if (check?.issueType === 'paywall') return false
	return check?.issueType === 'unknown' || check?.reason === 'consent_like_unknown'
}

async function askVisionAction(page, { url, check }) {
	if (!shouldUseVisionFallback(check)) return null

	const image = await page.screenshot({ type: 'jpeg', quality: 60 })
	const imageUrl = `data:image/jpeg;base64,${image.toString('base64')}`
	const response = await withTimeout(openai.chat.completions.create({
		model: OPENAI_SCREENSHOT_MODEL,
		temperature: 0,
		max_tokens: 300,
		messages: [
			{
				role: 'system',
				content: [
					'You are a webpage screenshot assistant.',
					'Return ONLY JSON.',
					'Goal: reveal article content safely.',
					'Never suggest login/subscribe/purchase actions.',
					'Allowed actions: click_text, click_selector, none.',
					'If blocked by captcha/paywall, return actionType=none and safe=false.',
				].join(' '),
			},
			{
				role: 'user',
				content: [
					{ type: 'text', text: `URL: ${url}\nCurrent issue: ${check?.issueType || 'unknown'}\nReturn JSON with keys: status, issueType, safe, actionType, targetText, cssSelector, reason.` },
					{ type: 'image_url', image_url: { url: imageUrl } },
				],
			},
			],
		}), VISION_TIMEOUT_MS, 'gpt_vision')
	estimateAndLogCost({
		task: 'screenshot_vision',
		model: OPENAI_SCREENSHOT_MODEL,
		usage: response?.usage,
		logger: log,
	})

	let content = response?.choices?.[0]?.message?.content || ''
	if (Array.isArray(content)) {
		content = content.map(p => p?.text || '').join('\n')
	}
	return extractJson(content)
}

function isSafeVisionAction(action) {
	if (!action || !action.safe) return false
	if (action.status !== 'actionable') return false
	if (!['click_text', 'click_selector'].includes(action.actionType)) return false

	if (action.actionType === 'click_text') {
		const text = normalizeText(action.targetText)
		if (!text) return false
		if (UNSAFE_CLICK_TEXTS.some(v => text.includes(v))) return false
		return SAFE_CLICK_TEXTS.some(v => text.includes(v))
	}

	if (action.actionType === 'click_selector') {
		const selector = String(action.cssSelector || '').trim()
		if (!selector || selector.length > 200) return false
		return /(cookie|consent|privacy|gdpr|onetrust|sp_message|overlay|modal)/i.test(selector)
	}

	return false
}

async function applyVisionAction(page, action) {
	if (!isSafeVisionAction(action)) return 0
	let clicks = 0

	if (action.actionType === 'click_text') {
		const target = [normalizeText(action.targetText)]
		for (const frame of page.frames()) {
			clicks += await clickByTextInFrame(frame, target)
		}
	}

	if (action.actionType === 'click_selector') {
		const selector = [String(action.cssSelector || '').trim()]
		for (const frame of page.frames()) {
			clicks += await clickBySelectorInFrame(frame, selector)
		}
	}

	if (clicks > 0) {
		await waitDom(page, 5000)
		await page.waitForTimeout(600)
	}
	return clicks
}

async function applyKnownFixes(page, startedAt) {
	assertBudget(startedAt, 'known_fix')
	let actions = 0
	actions += await clickKnownConsentButtons(page)
	actions += (await removeKnownOverlays(page)) > 0 ? 1 : 0
	if (actions > 0) {
		await waitDom(page, 5000)
		await page.waitForTimeout(600)
	}
	return actions
}

async function captureOne(context, { index, url }) {
	const startedAt = Date.now()
	let page
	try {
		page = await context.newPage()
		log('  goto...')
		assertBudget(startedAt, 'goto')
		await page.goto(url, { waitUntil: 'commit', timeout: GOTO_TIMEOUT_MS })
		log('  wait domcontentloaded...')
		await waitDom(page)
		await page.waitForTimeout(1200)

		let check = await inspectPage(page)
		log(`  health: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType} reason=${check.reason}`)

		for (let pass = 0; pass < KNOWN_FIX_PASSES && !check.ok; pass++) {
			const actions = await applyKnownFixes(page, startedAt)
			check = await inspectPage(page)
			log(`  health after known-fix #${pass + 1}: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType}`)
			if (!actions) break
		}

		if (!check.ok && shouldUseVisionFallback(check)) {
			log('  unresolved, asking GPT vision...')
			const action = await askVisionAction(page, { url, check })
			if (action) {
				log(`  gpt: status=${action.status || ''} issue=${action.issueType || ''} action=${action.actionType || 'none'} safe=${action.safe ? 'yes' : 'no'}`)
				const applied = await applyVisionAction(page, action)
				if (applied > 0) {
					check = await inspectPage(page)
					log(`  health after gpt action: ok=${check.ok ? 'yes' : 'no'} issue=${check.issueType}`)
				} else {
					const aiIssue = normalizeText([
						action.issueType || '',
						action.status || '',
						action.reason || '',
					].join(' '))
					if (
						aiIssue.includes('captcha')
						|| aiIssue.includes('security')
						|| aiIssue.includes('verification')
						|| aiIssue.includes('access_denied')
						|| aiIssue.includes('access denied')
						|| aiIssue.includes('blocked')
					) {
						check = { ...check, issueType: 'captcha', reason: 'captcha_from_gpt' }
					} else if (aiIssue.includes('paywall') || aiIssue.includes('subscribe')) {
						check = { ...check, issueType: 'paywall', reason: 'paywall_from_gpt' }
					} else if (aiIssue.includes('error')) {
						check = { ...check, issueType: 'unknown', reason: 'gpt_unresolved_error' }
					}
				}
			}
		}

		if (!check.ok) {
			throw new Error(`health_check_failed issue=${check.issueType} reason=${check.reason}`)
		}

		log('  cleanup + align...')
		await cleanupCosmetic(page)
		await alignToContent(page)
		await waitDom(page, 5000)
		await page.waitForTimeout(400)

		assertBudget(startedAt, 'screenshot')
		log('  save screenshot...')
		const filePath = join(IMG_DIR, `${index}.jpg`)
		await page.screenshot({ path: filePath, type: 'jpeg', quality: 90 })
		return { ok: true }
	} catch (e) {
		return { ok: false, error: String(e?.message || e) }
	} finally {
		if (page) {
			try { await page.close() } catch {}
		}
	}
}

export async function screenshots() {
	let content
	try {
		content = await readFile(SCREENSHOTS_FILE, 'utf-8')
	} catch {
		log('No screenshots.txt found')
		logRunTotalCost({ task: 'screenshots', logger: log })
		return
	}

	let lines = content.trim().split('\n').filter(l => l.trim())
	let items = []
	for (let i = 0; i < lines.length; i += 2) {
		let index = lines[i].trim()
		let url = parseUrl(lines[i + 1])
		if (index && url) items.push({ index, url })
	}

	if (items.length === 0) {
		log('No screenshots to take')
		logRunTotalCost({ task: 'screenshots', logger: log })
		return
	}

	log(`Taking ${items.length} screenshots...`)
	log(`Screenshot flow: known-fix${ENABLE_VISION_FALLBACK ? ' + gpt-fallback' : ''}`)

	let browser = await firefox.launch({ headless: true })
	let context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		deviceScaleFactor: 1,
		locale: 'en-US',
	})

	const stats = {
		total: items.length,
		ok: 0,
		fail: 0,
		byIssue: {},
	}

	for (const item of items) {
		log(`[${item.index}] ${item.url}`)
		const result = await withTimeout(captureOne(context, item), PER_URL_TIMEOUT_MS + 5000, `url_${item.index}`)
		if (!result.ok) {
			stats.fail++
			const error = String(result.error || '')
			log(`  Error: ${error}`)

			const match = error.match(/issue=([a-z_]+)/i)
			const issue = match?.[1] || 'other'
			stats.byIssue[issue] = (stats.byIssue[issue] || 0) + 1
		} else {
			stats.ok++
		}
	}

	await browser.close()
	const issueParts = Object.entries(stats.byIssue)
		.map(([k, v]) => `${k}=${v}`)
		.join(' ')
	log(`Screenshots done. total=${stats.total} ok=${stats.ok} fail=${stats.fail}${issueParts ? ` ${issueParts}` : ''}`)
	logRunTotalCost({ task: 'screenshots', logger: log })
}

if (process.argv[1]?.includes('screenshots')) screenshots()
